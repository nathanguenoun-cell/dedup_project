#!/usr/bin/env python3
"""
Server for the collaborative Deduplication platform.

  • Serves the static frontend (index.html, css/, js/).
  • Exposes a JSON API under /api/* (auth + projects)  — see api_handlers.py.
  • Proxies /api/messages to the Anthropic API (key stays server-side), or
    returns mock responses when no ANTHROPIC_API_KEY is set (UI testing).

Zero external dependencies (Python stdlib only).

Env vars:
  PORT               (Railway injects this)            default 7724
  ANTHROPIC_API_KEY  enables real LLM calls            default → mock mode
  ANTHROPIC_MODEL    model id                           default claude-sonnet-4-5
  DATA_DIR           where dedup.db lives (Railway Volume e.g. /data)
  DEDUP_SECRET       session signing secret (set in prod)
  COOKIE_SECURE=1    mark session cookie Secure (HTTPS)
"""

import http.server
import socketserver
import json
import os
import urllib.request
import urllib.error
import sys
import random
import re

import db
import auth
import api_handlers

PORT = int(os.environ.get('PORT', sys.argv[1] if len(sys.argv) > 1 else 7724))
DIR  = os.path.dirname(os.path.abspath(__file__))
API_KEY   = os.environ.get('ANTHROPIC_API_KEY', '')
MODEL     = os.environ.get('ANTHROPIC_MODEL', 'claude-sonnet-4-5')
MOCK_MODE = not API_KEY

db.init_db()

if MOCK_MODE:
    print("⚠  No ANTHROPIC_API_KEY found — running in MOCK mode (fake LLM responses).", flush=True)
    print("   Set ANTHROPIC_API_KEY=sk-ant-... to use the real API.", flush=True)
else:
    print(f"✓  API key found (****{API_KEY[-6:]}). Using real Anthropic API.", flush=True)
    print(f"   Model: {MODEL}  (override with ANTHROPIC_MODEL=...)", flush=True)

print(f"→  Data dir: {db.DATA_DIR}", flush=True)
print(f"→  Serving on http://0.0.0.0:{PORT}\n", flush=True)


def mock_response(n_issues, hint_pairs):
    """Build a structurally valid fake LLM grouping response for UI testing."""
    parent = list(range(n_issues))
    size   = [1] * n_issues
    MAX_CLUSTER = 5

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        if size[ra] + size[rb] > MAX_CLUSTER:
            return
        parent[rb] = ra
        size[ra] += size[rb]

    for a, b in hint_pairs:
        if 0 <= a < n_issues and 0 <= b < n_issues and random.random() < 0.45:
            union(a, b)

    clusters = {}
    for i in range(n_issues):
        clusters.setdefault(find(i), []).append(i)

    groups = []
    for members in clusters.values():
        if len(members) < 2:
            continue
        groups.append({
            "members": members,
            "confidence": round(random.uniform(0.55, 0.97), 2),
            "reason": "Mock: these describe the same underlying problem.",
        })
    return {"groups": groups}


def real_anthropic_call(body_bytes):
    """Forward to the Anthropic API (model chosen server-side)."""
    try:
        payload = json.loads(body_bytes)
        payload['model'] = MODEL
        body_bytes = json.dumps(payload).encode()
    except Exception:
        pass
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=body_bytes,
        headers={
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
        },
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

    # ── helpers ──
    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        return self.rfile.read(length) if length else b''

    def _send_json(self, status, obj, extra_headers=None):
        payload = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def _try_api(self, method, body):
        """Route /api/* (except /api/messages) to api_handlers. Returns True if handled."""
        path = self.path.split('?', 1)[0]
        if not path.startswith('/api/') or path == '/api/messages':
            return False
        status, obj, extra = api_handlers.dispatch(self, method, path, body)
        if status is None:
            self._send_json(404, {"error": "Unknown endpoint."})
        else:
            self._send_json(status, obj if obj is not None else {}, extra)
        return True

    # ── HTTP verbs ──
    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/'):
            self._try_api('GET', b'')
            return
        # SPA fallback: serve index.html for unknown non-file routes
        super().do_GET()

    def do_PUT(self):
        if not self._try_api('PUT', self._read_body()):
            self._send_json(404, {"error": "Unknown endpoint."})

    def do_PATCH(self):
        if not self._try_api('PATCH', self._read_body()):
            self._send_json(404, {"error": "Unknown endpoint."})

    def do_DELETE(self):
        if not self._try_api('DELETE', self._read_body()):
            self._send_json(404, {"error": "Unknown endpoint."})

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        body = self._read_body()

        if path == '/api/messages':
            # Require a valid session to use the LLM proxy.
            if not auth.current_user(self):
                self._send_json(401, {"error": "Not authenticated."})
                return
            try:
                if MOCK_MODE:
                    payload = json.loads(body)
                    prompt  = payload.get('messages', [{}])[0].get('content', '')
                    m = re.search(r'are (\d+) issues', prompt)
                    n_issues = int(m.group(1)) if m else 0
                    hint_pairs = [(int(a), int(b)) for a, b in re.findall(r'\((\d+),(\d+)\)', prompt)]
                    result = mock_response(n_issues, hint_pairs)
                    response_body = json.dumps({
                        "content": [{"type": "text", "text": json.dumps(result)}]
                    }).encode()
                else:
                    response_body = real_anthropic_call(body)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(response_body)
            except urllib.error.HTTPError as e:
                err = e.read().decode()
                print(f"  Anthropic API error {e.code}: {err[:200]}")
                self._send_json(e.code, {"error": err[:300]})
            except Exception as e:
                print(f"  Proxy error: {e}")
                self._send_json(500, {"error": str(e)})
            return

        if not self._try_api('POST', body):
            self._send_json(404, {"error": "Unknown endpoint."})


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


os.chdir(DIR)
with ThreadingHTTPServer(('0.0.0.0', PORT), Handler) as srv:
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
