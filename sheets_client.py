#!/usr/bin/env python3
"""sheets_client.py — pull the self-assessment straight from the master Google Sheet.

Replaces the manual "download the Dashboard as .xlsx and upload it" step. The
master sheet's `raw_data` tab holds one row per respondent: 163 topic columns (in
the exact template order) followed by `Your name | t | p | s | ...`, where the `t`
column is the project/client key (the same value picked in `Dashboard!B1`).

For a given project we keep the rows where `t == project`, average each topic
column, then group the topics by building block using the committed
`self_assessment_taxonomy.json` — producing the very same `(topics_by_bb, bb_avgs)`
structure `deck_builder.parse_self_assessment` returns, so the deck builder is
agnostic to the source.

The computation layer (`compute_assessment`, `select_projects`) is pure and unit
tested. Google auth/HTTP is imported lazily so the rest of the app — and the
tests — never need the Google libraries unless a Sheet is actually read.
"""
import json
import os
import re
from urllib.parse import quote

DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULT_SHEET_ID = "1IByDpzGtaU3S3GQSmKX7rvbcxfuRVro8likcehsnlyk"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# `t` values that are placeholders, not real clients.
_NON_PROJECTS = {"test", "[change to client name]"}

_TAXONOMY = None
_SESSION = None


# ── config ───────────────────────────────────────────────────────────────────
def sheet_id():
    return os.environ.get("SELF_ASSESSMENT_SHEET_ID", DEFAULT_SHEET_ID)


def responses_tab():
    return os.environ.get("SELF_ASSESSMENT_RESPONSES_TAB", "raw_data")


def taxonomy():
    """The committed template taxonomy: ordered [{bb, sub_bb, topic, atscale}]."""
    global _TAXONOMY
    if _TAXONOMY is None:
        with open(os.path.join(DIR, "self_assessment_taxonomy.json")) as f:
            _TAXONOMY = json.load(f)
    return _TAXONOMY


# ── pure computation (unit tested) ───────────────────────────────────────────
def _norm(v):
    return re.sub(r"\s+", " ", str(v if v is not None else "").strip()).lower()


def _col_index(header, name):
    target = _norm(name)
    for i, h in enumerate(header):
        if _norm(h) == target:
            return i
    return None


def _num(v):
    """Return v as float if it is a number (or numeric string), else None."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _project_col(header):
    idx = _col_index(header, "t")
    if idx is None:
        raise ValueError("raw_data header has no 't' (project) column")
    return idx


def _topic_col_count(header):
    """Topic columns are everything left of the 'Your name' meta column."""
    name_idx = _col_index(header, "Your name")
    if name_idx is None:
        raise ValueError("raw_data header has no 'Your name' column")
    return name_idx


def compute_assessment(header, rows, project, tax):
    """Build (topics_by_bb, bb_avgs) for `project` from raw response rows.

    Topic columns map positionally to `tax` (column i ↔ tax[i]) — this reproduces
    the Sheet's own Dashboard, including the few spots where a raw_data header
    label differs from the template topic label. Ratings are unrounded means of
    the numeric responses (blanks ignored); a topic with no responses gets
    rating None so its template row is preserved but no client dot is drawn.
    """
    n = _topic_col_count(header)
    if n != len(tax):
        raise ValueError(
            f"raw_data has {n} topic columns but the taxonomy has {len(tax)}; "
            "the master sheet and the committed taxonomy have drifted")
    t_idx = _project_col(header)
    want = _norm(project)

    selected = [r for r in rows if len(r) > t_idx and _norm(r[t_idx]) == want]

    ratings = []
    for i in range(n):
        vals = [_num(r[i]) for r in selected if i < len(r)]
        vals = [v for v in vals if v is not None]
        ratings.append(round(sum(vals) / len(vals), 10) if vals else None)

    topics_by_bb, bb_avgs = {}, {}
    for i, meta in enumerate(tax):
        bb = meta["bb"]
        topics_by_bb.setdefault(bb, []).append(
            {"topic": meta["topic"], "rating": ratings[i], "atscale": meta["atscale"]})

    for bb, topics in topics_by_bb.items():
        rv = [t["rating"] for t in topics if t["rating"] is not None]
        av = [t["atscale"] for t in topics]
        bb_avgs[bb] = {
            "client_avg": round(sum(rv) / len(rv), 1) if rv else None,
            "atscale_avg": round(sum(av) / len(av), 1) if av else None,
        }
    return topics_by_bb, bb_avgs


def select_projects(header, rows):
    """Distinct, case-insensitively sorted project names from the `t` column."""
    t_idx = _project_col(header)
    seen = {}
    for r in rows:
        if len(r) <= t_idx:
            continue
        val = str(r[t_idx]).strip() if r[t_idx] is not None else ""
        if not val or val.lower() in _NON_PROJECTS:
            continue
        seen.setdefault(val.lower(), val)  # keep first-seen casing
    return sorted(seen.values(), key=str.lower)


# ── Google I/O (lazy; needs google-auth + requests) ──────────────────────────
def _sa_info():
    raw = os.environ.get("GOOGLE_SA_JSON")
    if not raw:
        raise RuntimeError(
            "GOOGLE_SA_JSON is not set — provide the service-account credentials "
            "(JSON string or a path to the JSON file) and share the master sheet "
            "with the service account e-mail.")
    if os.path.exists(raw):
        with open(raw) as f:
            return json.load(f)
    return json.loads(raw)


def _session():
    global _SESSION
    if _SESSION is None:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
        creds = service_account.Credentials.from_service_account_info(
            _sa_info(), scopes=SCOPES)
        _SESSION = AuthorizedSession(creds)
    return _SESSION


def _read_values(rng):
    url = (f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id()}"
           f"/values/{quote(rng, safe='')}")
    resp = _session().get(url, params={"majorDimension": "ROWS"}, timeout=30)
    resp.raise_for_status()
    return resp.json().get("values", [])


def list_projects():
    """All selectable project/client names, for the Final Deck autocomplete."""
    values = _read_values(responses_tab())
    if not values:
        return []
    return select_projects(values[0], values[1:])


def fetch_assessment(project):
    """(topics_by_bb, bb_avgs) for `project` — same shape as parse_self_assessment."""
    values = _read_values(responses_tab())
    if not values:
        raise RuntimeError(f"'{responses_tab()}' tab is empty")
    return compute_assessment(values[0], values[1:], project, taxonomy())
