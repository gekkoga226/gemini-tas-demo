"""Serve the local UI mock. No video upload or Gemini endpoint is implemented."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from functools import partial
import os
import json

ROOT = Path(__file__).resolve().parent / "dist"

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/healthz":
            body = json.dumps({"status": "ok", "mode": "ui-mock", "gemini_connected": False}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer((host, port), partial(Handler, directory=str(ROOT)))
    print(f"Work Analysis UI mock: http://{host}:{port}/", flush=True)
    print("No video is uploaded. Gemini is not connected.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
