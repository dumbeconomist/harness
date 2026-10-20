#!/usr/bin/env python3
"""Fake OpenAI-compatible LLM on 127.0.0.1:9100/v1. If the conversation has no tool result yet and
a tool named *tasks_create* is offered, replies with a tool_call; else replies with a final answer.
Supports stream=true and stream=false. Logs request tool names to fake_llm.log (JSONL)."""
import json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
PORT = int(os.environ.get("LLM_PORT", "9100")); LOG = os.environ.get("LLM_LOG", "fake_llm.log")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        b = json.dumps({"object": "list", "data": [{"id": "fake-model", "object": "model"}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        msgs = req.get("messages", []); tools = [t["function"]["name"] for t in req.get("tools", [])]
        with open(LOG, "a") as f:
            f.write(json.dumps({"t": time.time(), "path": self.path, "stream": req.get("stream"), "tools": tools,
                                "roles": [m["role"] for m in msgs]}) + "\n")
        # CALL_TOOL=<name suffix> picks the tool to request (default tasks_create);
        # FORCE=1 requests it even if Hermes did not offer it (tests refusal of hallucinated calls).
        want = os.environ.get("CALL_TOOL", "tasks_create")
        target = next((t for t in tools if t.endswith(want)), None)
        if not target and os.environ.get("FORCE") == "1": target = want
        cargs = json.loads(os.environ.get("CALL_ARGS", '{"title": "spike task"}'))
        has_result = any(m["role"] == "tool" for m in msgs)
        usage = {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}
        if target and not has_result:
            tc = [{"index": 0, "id": "call_1", "type": "function",
                   "function": {"name": target, "arguments": json.dumps(cargs)}}]
            msg = {"role": "assistant", "content": None, "tool_calls": tc}; fin = "tool_calls"
        else:
            tr = next((m["content"] for m in reversed(msgs) if m["role"] == "tool"), "")
            msg = {"role": "assistant", "content": "DONE: tool said " + str(tr)[:200]}; fin = "stop"
        if req.get("stream"):
            self.send_response(200); self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close"); self.end_headers()
            def ev(d): self.wfile.write(b"data: " + json.dumps(d).encode() + b"\n\n"); self.wfile.flush()
            base = {"id": "chatcmpl-x", "object": "chat.completion.chunk", "created": 1, "model": "fake-model"}
            ev({**base, "choices": [{"index": 0, "delta": {"role": "assistant", **({"content": msg["content"]} if msg["content"] else {}),
                 **({"tool_calls": msg["tool_calls"]} if "tool_calls" in msg else {})}, "finish_reason": None}]})
            ev({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": fin}], "usage": usage})
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush(); self.close_connection = True
        else:
            b = json.dumps({"id": "chatcmpl-x", "object": "chat.completion", "created": 1, "model": "fake-model",
                            "choices": [{"index": 0, "message": msg, "finish_reason": fin}], "usage": usage}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
