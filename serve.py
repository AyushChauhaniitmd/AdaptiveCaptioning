"""
serve.py — No-cache HTTP server for development.
Serves the AdaptiveCaptioning root on port 8000.
Every response carries Cache-Control: no-cache, no-store, must-revalidate
so the browser always fetches fresh JS/CSS/VTT files.

Usage:
    py -3.11 serve.py
"""
import http.server
import json
import os
import socketserver
from pathlib import Path

PORT = 8000

def build_manifest():
    manifest = {
        "videos": [],
        "subtitles": {
            "adaptive": [],
            "baseline": [],
            "srt": [],
        },
    }

    videos_dir = Path("videos")
    if videos_dir.exists():
        for f in sorted(videos_dir.rglob("*.mp4")):
            manifest["videos"].append(f.as_posix())

    processed_dir = Path("processed")
    if processed_dir.exists():
        for f in sorted(processed_dir.rglob("*.vtt")):
            if "_adaptive" in f.name:
                manifest["subtitles"]["adaptive"].append(f.as_posix())
            elif "_baseline" in f.name:
                manifest["subtitles"]["baseline"].append(f.as_posix())
            else:
                manifest["subtitles"]["adaptive"].append(f.as_posix())

    subtitles_dir = Path("subtitles")
    if subtitles_dir.exists():
        for f in sorted(subtitles_dir.rglob("*.srt")):
            manifest["subtitles"]["srt"].append(f.as_posix())

    return manifest

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def copyfile(self, source, outputfile):
        try:
            if getattr(self, "range_length", None) is None:
                return super().copyfile(source, outputfile)

            remaining = self.range_length
            while remaining > 0:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            # Browser cancelled the request mid-flight (e.g. video seek / tab close).
            # This is normal behaviour — suppress silently.
            pass

    def send_head(self):
        self.range_length = None
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            parts = self.path.split("?", 1)[0].split("#", 1)[0]
            if not parts.endswith("/"):
                self.send_response(301)
                self.send_header("Location", parts + "/")
                self.end_headers()
                return None

            for index in ("index.html", "index.htm"):
                index_path = os.path.join(path, index)
                if os.path.isfile(index_path):
                    path = index_path
                    break
            else:
                return self.list_directory(path)

        ctype = self.guess_type(path)
        try:
            file_handle = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        file_size = os.fstat(file_handle.fileno()).st_size
        range_header = self.headers.get("Range")

        if not range_header:
            self.send_response(200)
            self.send_header("Content-type", ctype)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return file_handle

        start, end = self.parse_range_header(range_header, file_size)
        if start is None:
            file_handle.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{file_size}")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return None

        length = end - start + 1
        file_handle.seek(start)
        self.range_length = length

        self.send_response(206)
        self.send_header("Content-type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return file_handle

    def parse_range_header(self, range_header, file_size):
        if not range_header.startswith("bytes="):
            return None, None

        byte_range = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
        if "-" not in byte_range:
            return None, None

        start_text, end_text = byte_range.split("-", 1)
        try:
            if start_text == "":
                suffix_length = int(end_text)
                if suffix_length <= 0:
                    return None, None
                start = max(0, file_size - suffix_length)
                end = file_size - 1
            else:
                start = int(start_text)
                end = int(end_text) if end_text else file_size - 1
        except ValueError:
            return None, None

        if start < 0 or start >= file_size or end < start:
            return None, None

        return start, min(end, file_size - 1)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/player/manifest.json":
            payload = json.dumps(build_manifest(), indent=4).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma",        "no-cache")
        self.send_header("Expires",       "0")
        super().end_headers()

    def handle_error(self, request, client_address):
        # Suppress connection-abort noise from browsers cancelling requests.
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)

    def log_message(self, format, *args):
        # Quieter logs: only print non-200 responses and subtitle/video fetches
        code = args[1] if len(args) > 1 else ""
        path = args[0] if args else ""
        if str(code) != "200" or any(x in path for x in (".vtt", ".mp4", ".js", ".css")):
            super().log_message(format, *args)

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

def main():
    with ReusableTCPServer(("", PORT), NoCacheHandler) as httpd:
        print(f"[Nexus] Serving at http://localhost:{PORT}")
        print(f"[Nexus] Player  -> http://localhost:{PORT}/player/index.html")
        print(f"[Nexus] Live manifest endpoint active.")
        print(f"[Nexus] No-cache headers active. Ctrl+C to stop.")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
