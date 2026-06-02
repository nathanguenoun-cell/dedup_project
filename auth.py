"""
Authentication helpers — zero external dependencies.

  • Passwords: PBKDF2-HMAC-SHA256 with a per-user random salt.
  • Sessions: a stateless signed token in an HttpOnly cookie. The token is
    `base64(user_id|expiry).hex(hmac_sha256)` signed with DEDUP_SECRET.

On Railway, set DEDUP_SECRET as a stable env var. A regenerated secret would
invalidate every existing session on each deploy.
"""

import os
import hmac
import hashlib
import base64
import secrets
import time

import db

_PBKDF2_ITERS = 200_000
_TOKEN_TTL = 60 * 60 * 24 * 14  # 14 days
COOKIE_NAME = "dedup_session"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "") == "1"


def _secret():
    """Server signing secret. Prefer DEDUP_SECRET (stable across deploys).
    In local dev only, fall back to a generated, persisted .secret file."""
    env = os.environ.get("DEDUP_SECRET")
    if env:
        return env.encode()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".secret")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()
    gen = secrets.token_bytes(32)
    try:
        with open(path, "wb") as f:
            f.write(gen)
    except OSError:
        pass
    return gen


# ─── Passwords ────────────────────────────────────────────────────────────────

def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _PBKDF2_ITERS)
    return base64.b64encode(dk).decode(), salt


def verify_password(password, password_hash, salt):
    candidate, _ = hash_password(password, salt)
    return hmac.compare_digest(candidate, password_hash)


# ─── Session tokens ─────────────────────────────────────────────────────────────

def make_token(user_id):
    expiry = int(time.time()) + _TOKEN_TTL
    payload = f"{user_id}|{expiry}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    raw = f"{payload}|{sig}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def read_token(token):
    """Return user_id if the token is valid and unexpired, else None."""
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        user_id, expiry, sig = raw.split("|")
        payload = f"{user_id}|{expiry}"
        expected = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None
        if int(expiry) < int(time.time()):
            return None
        return int(user_id)
    except Exception:
        return None


# ─── Cookie helpers ─────────────────────────────────────────────────────────────

def cookie_header(token):
    parts = [
        f"{COOKIE_NAME}={token}",
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        f"Max-Age={_TOKEN_TTL}",
    ]
    if COOKIE_SECURE:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header():
    parts = [f"{COOKIE_NAME}=", "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"]
    if COOKIE_SECURE:
        parts.append("Secure")
    return "; ".join(parts)


def _parse_cookies(cookie_header_value):
    out = {}
    if not cookie_header_value:
        return out
    for part in cookie_header_value.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def current_user(handler):
    """Read the session cookie from the request and return the user dict, or None."""
    cookies = _parse_cookies(handler.headers.get("Cookie", ""))
    token = cookies.get(COOKIE_NAME)
    if not token:
        return None
    user_id = read_token(token)
    if user_id is None:
        return None
    return db.get_user_by_id(user_id)
