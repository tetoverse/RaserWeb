#!/usr/bin/env python3
"""
Lightweight always-on local yt-dlp HTTP resolver for RaserWeb.
Keeps Python + yt_dlp + YouTube player JS warm in memory on 127.0.0.1:3851
to eliminate per-track Python/yt-dlp startup latency.
"""

import json
import os
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

YTDLP_ZIPAPP = "/usr/local/bin/yt-dlp"
if os.path.exists(YTDLP_ZIPAPP) and YTDLP_ZIPAPP not in sys.path:
    sys.path.insert(0, YTDLP_ZIPAPP)

import yt_dlp  # noqa: E402

PORT = int(os.environ.get("YT_RESOLVER_PORT", "3851"))
_thread_local = threading.local()


def get_ydl(use_tvhtml5=True):
    attr = "ydl_tv" if use_tvhtml5 else "ydl_default"
    inst = getattr(_thread_local, attr, None)
    if inst is not None:
        return inst

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "format": "140/ba/b",
        "js_runtimes": {"node": {}},
    }
    if use_tvhtml5:
        opts["extractor_args"] = {"youtube": {"player_client": ["tvhtml5"]}}

    inst = yt_dlp.YoutubeDL(opts)
    setattr(_thread_local, attr, inst)
    return inst


def extract_stream_info(target_url):
    last_err = None
    for use_tv in (True, False):
        try:
            ydl = get_ydl(use_tvhtml5=use_tv)
            info = ydl.extract_info(target_url, download=False)
            if not info:
                continue
            if "entries" in info and info["entries"]:
                info = info["entries"][0]
            stream_url = info.get("url")
            if not stream_url and info.get("requested_formats"):
                stream_url = info["requested_formats"][0].get("url")
            if stream_url and stream_url.startswith("https://"):
                return {
                    "success": True,
                    "url": stream_url,
                    "itag": info.get("format_id"),
                    "ext": info.get("ext"),
                    "contentLength": info.get("filesize") or info.get("filesize_approx"),
                }
        except Exception as exc:
            last_err = str(exc)
    return {"success": False, "error": last_err or "Extraction failed"}


class ResolverHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            return self._send_json(200, {"status": "ok"})

        if parsed.path == "/resolve":
            qs = urllib.parse.parse_qs(parsed.query)
            target = (qs.get("url") or [""])[0].strip()
            if not target:
                return self._send_json(400, {"success": False, "error": "Missing url"})
            result = extract_stream_info(target)
            return self._send_json(200 if result.get("success") else 502, result)

        return self._send_json(404, {"success": False, "error": "Not found"})


if __name__ == "__main__":
    # Pre-warm primary YoutubeDL instance on main thread
    get_ydl(use_tvhtml5=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), ResolverHandler)
    print(f"yt_resolver listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
