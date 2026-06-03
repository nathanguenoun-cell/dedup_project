"""
JSON API endpoint logic for auth + projects.

`dispatch(handler, method, path, body_bytes)` returns a tuple:
    (status_code:int, body:dict|None, extra_headers:list[(name, value)])

`server.py` writes the JSON response and any extra headers (e.g. Set-Cookie).
Returning (None, None, None) means "not an API route I handle" → caller falls
through to static file serving.
"""

import json
import re
import sqlite3

import db
import auth

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ─── helpers ────────────────────────────────────────────────────────────────

def _json_body(body_bytes):
    if not body_bytes:
        return {}
    try:
        return json.loads(body_bytes)
    except Exception:
        return {}


def _err(status, message):
    return (status, {"error": message}, [])


def _ok(body, extra_headers=None):
    return (200, body, extra_headers or [])


# ─── auth endpoints ─────────────────────────────────────────────────────────

def _register(body):
    email = (body.get("email") or "").strip().lower()
    name = (body.get("name") or "").strip()
    password = body.get("password") or ""
    if not EMAIL_RE.match(email):
        return _err(400, "Invalid email address.")
    if not name:
        return _err(400, "Name is required.")
    if len(password) < 8:
        return _err(400, "Password must be at least 8 characters.")
    if db.get_user_by_email(email):
        return _err(409, "An account with this email already exists.")
    pwd_hash, salt = auth.hash_password(password)
    user_id = db.create_user(email, name, pwd_hash, salt)
    token = auth.make_token(user_id)
    return _ok(
        {"user": db.public_user(db.get_user_by_id(user_id))},
        [("Set-Cookie", auth.cookie_header(token))],
    )


def _login(body):
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    user = db.get_user_by_email(email)
    if not user or not auth.verify_password(password, user["password_hash"], user["salt"]):
        return _err(401, "Incorrect email or password.")
    token = auth.make_token(user["id"])
    return _ok(
        {"user": db.public_user(user)},
        [("Set-Cookie", auth.cookie_header(token))],
    )


def _logout():
    return _ok({"ok": True}, [("Set-Cookie", auth.clear_cookie_header())])


def _me(user):
    if not user:
        return _err(401, "Not authenticated.")
    return _ok({"user": db.public_user(user)})


# ─── project endpoints ──────────────────────────────────────────────────────

def _list_projects(user):
    return _ok(db.list_projects_for_user(user["id"]))


def _create_project(user, body):
    name = (body.get("name") or "").strip()
    if not name:
        return _err(400, "Project name is required.")
    pid = db.create_project(name, user["id"])
    return _ok({"id": pid})


def _get_project(user, pid):
    project = db.get_project(pid)
    if not project:
        return _err(404, "Project not found.")
    if not db.is_member(pid, user["id"]):
        return _err(403, "You do not have access to this project.")
    return _ok({
        "project": project,
        "members": db.list_members(pid),
        "data": db.get_project_data(pid),
        "is_owner": project["owner_id"] == user["id"],
    })


def _patch_project(user, pid, body):
    if not db.is_member(pid, user["id"]):
        return _err(403, "You do not have access to this project.")
    name = body.get("name")
    status = body.get("status")
    if status is not None and status not in ("draft", "review", "completed"):
        return _err(400, "Invalid status.")
    db.update_project(pid, name=name, status=status)
    return _ok({"ok": True})


def _delete_project(user, pid):
    if not db.is_owner(pid, user["id"]):
        return _err(403, "Only the owner can delete this project.")
    db.delete_project(pid)
    return _ok({"ok": True})


def _save_data(user, pid, body):
    if not db.is_member(pid, user["id"]):
        return _err(403, "You do not have access to this project.")
    db.save_project_data(
        pid,
        body.get("file_name", ""),
        body.get("raw_data", []),
        body.get("groups", []),
        body.get("decisions", {}),
        body.get("removed_ids", []),
        body.get("failed_blocks", []),
    )
    status = body.get("status")
    if status in ("draft", "review", "completed"):
        db.update_project(pid, status=status)
    return _ok({"ok": True})


def _add_member(user, pid, body):
    if not db.is_owner(pid, user["id"]):
        return _err(403, "Only the owner can invite members.")
    email = (body.get("email") or "").strip().lower()
    invitee = db.get_user_by_email(email)
    if not invitee:
        return _err(404, "No operating partner is registered with this email.")
    db.add_member(pid, invitee["id"], "member")
    return _ok({"member": {"id": invitee["id"], "email": invitee["email"], "name": invitee["name"], "role": "member"}})


def _remove_member(user, pid, target_user_id):
    if not db.is_owner(pid, user["id"]):
        return _err(403, "Only the owner can remove members.")
    db.remove_member(pid, target_user_id)
    return _ok({"ok": True})


# ─── dispatch ───────────────────────────────────────────────────────────────

def dispatch(handler, method, path, body_bytes):
    if not path.startswith("/api/"):
        return (None, None, None)

    body = _json_body(body_bytes)
    user = auth.current_user(handler)

    try:
        # ── auth (no session required for register/login) ──
        if path == "/api/auth/register" and method == "POST":
            return _register(body)
        if path == "/api/auth/login" and method == "POST":
            return _login(body)
        if path == "/api/auth/logout" and method == "POST":
            return _logout()
        if path == "/api/auth/me" and method == "GET":
            return _me(user)

        # ── everything below requires a session ──
        if path.startswith("/api/projects"):
            if not user:
                return _err(401, "Not authenticated.")

            if path == "/api/projects" and method == "GET":
                return _list_projects(user)
            if path == "/api/projects" and method == "POST":
                return _create_project(user, body)

            m = re.fullmatch(r"/api/projects/(\d+)", path)
            if m:
                pid = int(m.group(1))
                if method == "GET":
                    return _get_project(user, pid)
                if method == "PATCH":
                    return _patch_project(user, pid, body)
                if method == "DELETE":
                    return _delete_project(user, pid)

            m = re.fullmatch(r"/api/projects/(\d+)/data", path)
            if m and method == "PUT":
                return _save_data(user, int(m.group(1)), body)

            m = re.fullmatch(r"/api/projects/(\d+)/members", path)
            if m and method == "POST":
                return _add_member(user, int(m.group(1)), body)

            m = re.fullmatch(r"/api/projects/(\d+)/members/(\d+)", path)
            if m and method == "DELETE":
                return _remove_member(user, int(m.group(1)), int(m.group(2)))

        return _err(404, "Unknown endpoint.")

    except sqlite3.IntegrityError as e:
        return _err(409, f"Conflict: {e}")
    except Exception as e:
        return _err(500, f"Server error: {e}")
