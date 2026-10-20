#!/usr/bin/env python3
"""Tiny fake MCP server (Streamable HTTP, JSON responses only) on 127.0.0.1:8765/mcp.
Logs every request (method, headers of interest, body) to fake_mcp.log (JSONL).
Requires `Authorization: Bearer $TOKEN` (default 'spike-token')."""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("TOKEN", "spike-token")
PORT = int(os.environ.get("PORT", "8765"))
SLEEP = float(os.environ.get("TOOL_SLEEP", "0"))   # simulate human-approval wait
LOG = os.environ.get("MCP_LOG", "fake_mcp.log")
TOOL = {"name": "tasks_create", "description": "Create a task in Workbench.",
        "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]},
        "annotations": {"readOnlyHint": False}}

def log(rec):
    with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        log({"t": time.time(), "http": "GET", "path": self.path, "accept": self.headers.get("Accept"),
             "auth": self.headers.get("Authorization")})
        self._send(405, b"", extra={"Allow": "POST"})
    do_HEAD = do_GET
    def do_DELETE(self):
        log({"t": time.time(), "http": "DELETE"}); self._send(200)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); raw = self.rfile.read(n)
        msg = json.loads(raw or b"{}")
        log({"t": time.time(), "http": "POST", "auth": self.headers.get("Authorization"),
             "accept": self.headers.get("Accept"), "proto": self.headers.get("MCP-Protocol-Version"),
             "session": self.headers.get("Mcp-Session-Id"), "body": msg})
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._send(401, b'{"error":"unauthorized"}')
        m, i = msg.get("method"), msg.get("id")
        if i is None:  # notification
            return self._send(202)
        if m == "initialize":
            res = {"protocolVersion": msg["params"].get("protocolVersion", "2025-03-26"),
                   "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": "fake-workbench", "version": "0.0.1"}}
        elif m == "tools/list":
            res = {"tools": [TOOL]}
        elif m == "tools/call":
            time.sleep(SLEEP)
            args = msg["params"].get("arguments", {})
            res = {"content": [{"type": "text", "text": json.dumps({"ok": True, "id": "t_1", "title": args.get("title")})}],
                   "isError": False}
        elif m == "ping":
            res = {}
        else:
            return self._send(200, json.dumps({"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": "no such method"}}).encode())
        self._send(200, json.dumps({"jsonrpc": "2.0", "id": i, "result": res}).encode(), extra={"Mcp-Session-Id": "sess-1"})

if __name__ == "__main__":
    print(f"fake MCP on 127.0.0.1:{PORT}/mcp", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
