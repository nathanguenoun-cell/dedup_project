"""
SQLite persistence layer for the Deduplication collaborative platform.

Zero external dependencies — uses the stdlib `sqlite3`.

The database path is configurable via the DATA_DIR env var:
  • If DATA_DIR is set (e.g. a mounted Railway Volume at /data), the DB lives
    at ${DATA_DIR}/dedup.db.
  • Otherwise it falls back to ./dedup.db next to this file (local dev).

This matters on Railway: the container filesystem is ephemeral and reset on
each deploy, so the DB MUST live on a mounted Volume to persist accounts/projects.
"""

import os
import sqlite3
import json
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", _HERE)
DB_PATH = os.path.join(DATA_DIR, "dedup.db")


def connect():
    """Open a fresh connection. One per request keeps threads isolated; SQLite's
    file locking handles concurrency for our short writes."""
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db():
    """Create tables if they don't exist. Safe to call on every startup."""
    conn = connect()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                email         TEXT UNIQUE NOT NULL,
                name          TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                salt          TEXT NOT NULL,
                created_at    INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status     TEXT NOT NULL DEFAULT 'draft',  -- draft | review | completed
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_members (
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role       TEXT NOT NULL DEFAULT 'member',  -- owner | member
                PRIMARY KEY (project_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS project_data (
                project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                file_name   TEXT NOT NULL DEFAULT '',
                raw_data    TEXT NOT NULL DEFAULT '[]',
                groups      TEXT NOT NULL DEFAULT '[]',
                decisions   TEXT NOT NULL DEFAULT '{}',
                removed_ids TEXT NOT NULL DEFAULT '[]',
                updated_at  INTEGER NOT NULL
            );
            """
        )
        # Idempotent migration: add columns introduced after initial release.
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(project_data)")]
        if "failed_blocks" not in cols:
            conn.execute("ALTER TABLE project_data ADD COLUMN failed_blocks TEXT NOT NULL DEFAULT '[]'")
        conn.commit()
    finally:
        conn.close()


def now():
    return int(time.time())


# ─── Users ──────────────────────────────────────────────────────────────────

def create_user(email, name, password_hash, salt):
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO users (email, name, password_hash, salt, created_at) VALUES (?,?,?,?,?)",
            (email.strip().lower(), name.strip(), password_hash, salt, now()),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_user_by_email(email):
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM users WHERE email = ?", (email.strip().lower(),)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_user_by_id(user_id):
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def public_user(user):
    """Strip sensitive fields before sending to the client."""
    if not user:
        return None
    return {"id": user["id"], "email": user["email"], "name": user["name"]}


# ─── Projects ───────────────────────────────────────────────────────────────

def create_project(name, owner_id):
    conn = connect()
    try:
        ts = now()
        cur = conn.execute(
            "INSERT INTO projects (name, owner_id, status, created_at, updated_at) VALUES (?,?,?,?,?)",
            (name.strip(), owner_id, "draft", ts, ts),
        )
        pid = cur.lastrowid
        conn.execute(
            "INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,?)",
            (pid, owner_id, "owner"),
        )
        conn.execute(
            "INSERT INTO project_data (project_id, updated_at) VALUES (?,?)",
            (pid, ts),
        )
        conn.commit()
        return pid
    finally:
        conn.close()


def get_project(project_id):
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def is_member(project_id, user_id):
    conn = connect()
    try:
        row = conn.execute(
            "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, user_id),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def is_owner(project_id, user_id):
    p = get_project(project_id)
    return p is not None and p["owner_id"] == user_id


def list_projects_for_user(user_id):
    """Return {created: [...], invited: [...]} with lightweight meta per project."""
    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT p.*, pm.role,
                   (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS member_count,
                   (SELECT json_array_length(d.raw_data) FROM project_data d WHERE d.project_id = p.id) AS issue_count
            FROM projects p
            JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
            ORDER BY p.updated_at DESC
            """,
            (user_id,),
        ).fetchall()
        created, invited = [], []
        for r in rows:
            item = {
                "id": r["id"],
                "name": r["name"],
                "status": r["status"],
                "owner_id": r["owner_id"],
                "role": r["role"],
                "member_count": r["member_count"],
                "issue_count": r["issue_count"] or 0,
                "updated_at": r["updated_at"],
            }
            (created if r["owner_id"] == user_id else invited).append(item)
        return {"created": created, "invited": invited}
    finally:
        conn.close()


def update_project(project_id, name=None, status=None):
    conn = connect()
    try:
        sets, params = [], []
        if name is not None:
            sets.append("name = ?"); params.append(name.strip())
        if status is not None:
            sets.append("status = ?"); params.append(status)
        if not sets:
            return
        sets.append("updated_at = ?"); params.append(now())
        params.append(project_id)
        conn.execute(f"UPDATE projects SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
    finally:
        conn.close()


def delete_project(project_id):
    conn = connect()
    try:
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        conn.commit()
    finally:
        conn.close()


# ─── Project members ──────────────────────────────────────────────────────────

def list_members(project_id):
    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT u.id, u.email, u.name, pm.role
            FROM project_members pm JOIN users u ON u.id = pm.user_id
            WHERE pm.project_id = ?
            ORDER BY pm.role DESC, u.name
            """,
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def add_member(project_id, user_id, role="member"):
    conn = connect()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?,?,?)",
            (project_id, user_id, role),
        )
        conn.commit()
    finally:
        conn.close()


def remove_member(project_id, user_id):
    conn = connect()
    try:
        conn.execute(
            "DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role != 'owner'",
            (project_id, user_id),
        )
        conn.commit()
    finally:
        conn.close()


# ─── Project data (shared dedup state) ────────────────────────────────────────

def get_project_data(project_id):
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM project_data WHERE project_id = ?", (project_id,)
        ).fetchone()
        if not row:
            return {"file_name": "", "raw_data": [], "groups": [], "decisions": {}, "removed_ids": [], "failed_blocks": []}
        keys = row.keys()
        return {
            "file_name": row["file_name"],
            "raw_data": json.loads(row["raw_data"]),
            "groups": json.loads(row["groups"]),
            "decisions": json.loads(row["decisions"]),
            "removed_ids": json.loads(row["removed_ids"]),
            "failed_blocks": json.loads(row["failed_blocks"]) if "failed_blocks" in keys and row["failed_blocks"] else [],
            "updated_at": row["updated_at"],
        }
    finally:
        conn.close()


def save_project_data(project_id, file_name, raw_data, groups, decisions, removed_ids, failed_blocks=None):
    """Last-write-wins persistence of the shared dedup state."""
    conn = connect()
    try:
        conn.execute(
            """
            INSERT INTO project_data (project_id, file_name, raw_data, groups, decisions, removed_ids, failed_blocks, updated_at)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(project_id) DO UPDATE SET
                file_name=excluded.file_name,
                raw_data=excluded.raw_data,
                groups=excluded.groups,
                decisions=excluded.decisions,
                removed_ids=excluded.removed_ids,
                failed_blocks=excluded.failed_blocks,
                updated_at=excluded.updated_at
            """,
            (
                project_id,
                file_name or "",
                json.dumps(raw_data or []),
                json.dumps(groups or []),
                json.dumps(decisions or {}),
                json.dumps(removed_ids or []),
                json.dumps(failed_blocks or []),
                now(),
            ),
        )
        conn.commit()
    finally:
        conn.close()
