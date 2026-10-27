"""Local backend for the RISA-3D control panel.

Serves index.html and exposes a small JSON API that finds and launches RISA-3D.
Run:  python server.py   then open http://127.0.0.1:8765
"""
import glob
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST, PORT = "127.0.0.1", 8765
APP_DIR = os.path.dirname(os.path.abspath(__file__))
RISA_DIR = r"C:\Program Files\RISA"
UPLOAD_DIR = os.path.join(APP_DIR, "uploads")
SKIP = ("unins", "update", "setup", "install", "demobackup")
JOBS = {}  # background jobs (sketch reading): id -> {state, log, result, error}


def file_version(path):
    """Return the exe's FileVersion via PowerShell (stdlib has no version reader)."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-Item -LiteralPath '{path}').VersionInfo.FileVersion"],
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def find_risa3d():
    """Find RISA-3D executables in the RISA install folder, newest first."""
    found = set()
    for p in glob.glob(os.path.join(RISA_DIR, "risa*3d*.exe")):
        if not any(s in p.lower() for s in SKIP):
            found.add(os.path.normpath(p))
    installs = [{"path": p, "version": file_version(p)} for p in found]

    def key(i):
        try:
            return tuple(int(x) for x in i["version"].split("."))
        except ValueError:
            return (0,)
    return sorted(installs, key=key, reverse=True)


def count_pages(data):
    """Rough page count from the raw PDF bytes (0 if it can't tell)."""
    return len(re.findall(rb"/Type\s*/Page(?![a-zA-Z])", data))


def safe_stem(stem):
    return re.sub(r"[^\w.-]", "_", stem or "")


def read_sketch_job(job, stem, skip_ocr, engine="cc"):
    """Background job: OCR first; if it can't read the sketch, run the agent
    (engine "cc" = Claude Code on the user's login, "api" = Claude API with a key)."""
    import sketch_agent
    log = job["log"].append
    try:
        with open(os.path.join(UPLOAD_DIR, stem + "_photo.jpg"), "rb") as f:
            photo = f.read()
        with open(os.path.join(UPLOAD_DIR, stem + "_lines.json")) as f:
            lines = json.load(f)
        if not skip_ocr:
            log("Trying offline OCR on the handwriting…")
            ocr = sketch_agent.ocr_labels(photo)
            found = [x["text"] for x in ocr["sizes"] + ocr["dims"]]
            log("OCR read: " + (", ".join(found) if found else "nothing usable"))
            if sketch_agent.ocr_is_enough(ocr, lines["members"]):
                job.update(state="done", result={"source": "ocr", "ocr": ocr,
                                                 "sizes": sketch_agent.ocr_sizes_to_members(ocr, lines)})
                return
            log("OCR can't read this handwriting well enough.")
            if engine == "api" and not sketch_agent.get_key():
                job["state"] = "need_key"
                return
        if engine == "cc":
            import cc_agent
            framing, doubts, _ = cc_agent.run_sketch(UPLOAD_DIR, stem, log)
            rounds = None
        else:
            log("Starting the AI agent (draft → check → redo)…")
            framing, doubts, rounds = sketch_agent.run_agent(photo, lines, log)
        lines["photo"] = "data:image/jpeg;base64," + __import__("base64").b64encode(photo).decode()
        data = sketch_agent.to_editor(framing, lines)
        with open(os.path.join(UPLOAD_DIR, stem + "_agent.json"), "w") as f:
            json.dump(framing.model_dump(), f, indent=2)
        log(f"Done after {rounds} round(s)." if rounds else "Done.")
        job.update(state="done", result={"source": "agent", "editor": data, "doubts": doubts,
                                         "assumptions": framing.assumptions, "labels": framing.labels_read})
    except Exception as e:
        job.update(state="error", error=f"{type(e).__name__}: {e}")


def _photo_url(path):
    with open(path, "rb") as f:
        return "data:image/jpeg;base64," + __import__("base64").b64encode(f.read()).decode()


def design_job(job, stem, instruction=None, state=None, engine="cc"):
    """Background job: the AI agent lays out (or extends) framing on a PDF plan."""
    import plan_agent
    import sketch_agent
    log = job["log"].append
    try:
        if engine == "cc":
            import cc_agent
            current = None
            if instruction:
                meta = json.load(open(os.path.join(UPLOAD_DIR, stem + "_plan.json")))
                current = plan_agent.from_editor(state, meta)
                log("Asking Claude Code to add: " + instruction)
            fr, doubts, meta = cc_agent.run_plan(UPLOAD_DIR, stem, log, instruction, current)
            reply = sketch_agent.AgentReply(framing=fr, matches_sketch=True, remaining_doubts=doubts)
        elif not sketch_agent.get_key():
            job["state"] = "need_key"
            return
        elif instruction:
            meta = json.load(open(os.path.join(UPLOAD_DIR, stem + "_plan.json")))
            current = plan_agent.from_editor(state, meta)
            log("Asking the agent to add: " + instruction)
            reply, meta = plan_agent.run_more(UPLOAD_DIR, stem, instruction, current, log)
        else:
            log("Starting the AI agent (lay out → review over the plan → revise)…")
            reply, meta = plan_agent.run_design(UPLOAD_DIR, stem, log)
        fr = reply.framing
        with open(os.path.join(UPLOAD_DIR, stem + "_design.json"), "w") as f:
            json.dump(fr.model_dump(), f, indent=2)
        page = os.path.join(UPLOAD_DIR, stem + "_page.jpg")
        log("Done.")
        job.update(state="done", result={
            "editor": plan_agent.to_editor(fr, meta, _photo_url(page), stem),
            "doubts": reply.remaining_doubts, "assumptions": fr.assumptions, "labels": fr.labels_read})
    except Exception as e:
        job.update(state="error", error=f"{type(e).__name__}: {e}")


def start_job(target, *args):
    jid = uuid.uuid4().hex[:8]
    JOBS[jid] = {"state": "running", "log": [], "result": None, "error": None}
    threading.Thread(target=target, daemon=True, args=(JOBS[jid], *args)).start()
    return jid


def launch(exe, model=None):
    """Start RISA-3D. With no model it opens on a new, untitled model."""
    if not os.path.isfile(exe):
        raise FileNotFoundError(f"Executable not found: {exe}")
    args = [exe] + ([model] if model else [])
    proc = subprocess.Popen(args, cwd=os.path.dirname(exe))
    return proc.pid


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # Allow the page to call the API when opened directly as a file.
        self.send_header("Access-Control-Allow-Origin", "null")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(os.path.join(APP_DIR, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif self.path == "/editor.js":
            with open(os.path.join(APP_DIR, "editor.js"), "rb") as f:
                self._send(200, f.read(), "text/javascript; charset=utf-8")
        elif self.path == "/api/installs":
            self._send(200, {"installs": find_risa3d()})
        elif self.path.startswith("/api/job"):
            job = JOBS.get(parse_qs(urlparse(self.path).query).get("id", [""])[0])
            self._send(200, job) if job else self._send(404, {"error": "unknown job"})
        elif self.path == "/api/key":
            import sketch_agent
            self._send(200, {"has_key": bool(sketch_agent.get_key())})
        elif self.path == "/api/engines":
            import cc_agent
            import sketch_agent
            self._send(200, {"claude_code": bool(cc_agent.find_claude()), "api_key": bool(sketch_agent.get_key())})
        else:
            self._send(404, {"error": "not found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path.startswith("/api/plan"):
            return self.save_plan()
        if self.path.startswith("/api/sketch"):
            return self.process_sketch()
        if self.path == "/api/frame":
            return self.save_frame()
        if self.path.startswith("/api/read"):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            return self._send(200, {"id": start_job(read_sketch_job, safe_stem(q.get("stem")), q.get("skip_ocr") == "1",
                                                    q.get("engine", "cc"))})
        if self.path.startswith("/api/design"):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            return self._send(200, {"id": start_job(design_job, safe_stem(q.get("stem")),
                                                    body.get("instruction"), body.get("state"), q.get("engine", "cc"))})
        if self.path == "/api/key":
            return self.store_key()
        if self.path == "/api/risa":
            return self.send_to_risa()
        if self.path != "/api/new-model":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            exe = body.get("exe")
            if not exe:
                installs = find_risa3d()
                if not installs:
                    return self._send(404, {"error": "RISA-3D is not installed."})
                exe = installs[0]["path"]
            # Only launch exes we discovered ourselves.
            if exe not in {i["path"] for i in find_risa3d()}:
                return self._send(400, {"error": "Unknown executable."})
            pid = launch(exe)
            self._send(200, {"ok": True, "exe": exe, "pid": pid})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def save_plan(self):
        """Store an uploaded framing-plan PDF plus its scale info in uploads/."""
        try:
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if not data.startswith(b"%PDF"):
                return self._send(400, {"error": "That file is not a PDF."})
            ratio = float(q.get("ratio", 0))
            page = int(q.get("page", 1))
            pages = count_pages(data)
            if ratio <= 0:
                return self._send(400, {"error": "Invalid scale."})
            if pages and not 1 <= page <= pages:
                return self._send(400, {"error": f"Page {page} is out of range (PDF has {pages} pages)."})

            name = os.path.basename(q.get("name", "plan.pdf"))
            stem = time.strftime("%Y%m%d-%H%M%S_") + safe_stem(os.path.splitext(name)[0])
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            pdf_path = os.path.join(UPLOAD_DIR, stem + ".pdf")
            with open(pdf_path, "wb") as f:
                f.write(data)
            info = {"name": name, "pdf": pdf_path, "pages": pages, "page": page,
                    "scale": q.get("scale", ""), "ratio": ratio}
            with open(os.path.join(UPLOAD_DIR, stem + ".json"), "w") as f:
                json.dump(info, f, indent=2)
            # Render the page at scale for the editor and the agent.
            import plan_agent
            meta = plan_agent.prepare(pdf_path, page, ratio, os.path.join(UPLOAD_DIR, stem))
            k = meta["px_per_ft"]
            info.update(stem=stem, sheet_ft=meta["sheet_ft"], words=len(meta["words"]), editor={
                "width": meta["width"], "height": meta["height"], "stem": stem, "name": name,
                "photo": _photo_url(os.path.join(UPLOAD_DIR, stem + "_page.jpg")),
                "grid": {"x": [], "y": []}, "nodes": [], "members": [], "tol": 0.5 * k, "snap": 1.0 * k})
            self._send(200, info)
        except Exception as e:
            self._send(500, {"error": str(e)})

    def process_sketch(self):
        """Turn an uploaded sketch photo into line work; save photo, overlay and JSON."""
        try:
            import sketch  # heavy imports (OpenCV, scikit-image) only when needed
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            result, png, photo = sketch.process(data, int(q.get("rotate", 0)))

            name = os.path.basename(q.get("name", "sketch.jpg"))
            stem = time.strftime("%Y%m%d-%H%M%S_") + safe_stem(os.path.splitext(name)[0])
            result["stem"] = stem
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            with open(os.path.join(UPLOAD_DIR, stem + os.path.splitext(name)[1]), "wb") as f:
                f.write(data)
            with open(os.path.join(UPLOAD_DIR, stem + "_lines.png"), "wb") as f:
                f.write(png)
            with open(os.path.join(UPLOAD_DIR, stem + "_photo.jpg"), "wb") as f:
                f.write(photo)  # the rotated/resized photo the editor and agent work on
            result["name"] = name
            with open(os.path.join(UPLOAD_DIR, stem + "_lines.json"), "w") as f:
                json.dump(result, f, indent=2)
            self._send(200, {**result, "photo": sketch.to_data_url(photo, "image/jpeg")})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def save_frame(self):
        """Save the edited framing (nodes/members in feet, sizes) next to the sketch."""
        try:
            frame = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            stem = re.sub(r"[^\w.-]", "_", frame.get("stem") or time.strftime("%Y%m%d-%H%M%S_frame"))
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            path = os.path.join(UPLOAD_DIR, stem + "_frame.json")
            with open(path, "w") as f:
                json.dump(frame, f, indent=2)
            self._send(200, {"ok": True, "path": path})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def store_key(self):
        try:
            import sketch_agent
            key = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))).get("key", "").strip()
            if not key:
                return self._send(400, {"error": "Enter a key."})
            sketch_agent.save_key(key)
            self._send(200, {"ok": True})
        except Exception as e:
            self._send(400, {"error": f"Key not accepted: {e}"})

    def send_to_risa(self):
        """Write the edited framing as a RISA-3D model and open it in RISA-3D."""
        try:
            import risa_r3d
            frame = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if not frame.get("members"):
                return self._send(400, {"error": "The framing has no members."})
            installs = find_risa3d()
            if not installs:
                return self._send(404, {"error": "RISA-3D is not installed."})
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            stem = safe_stem(frame.get("stem")) or time.strftime("%Y%m%d-%H%M%S_frame")
            path = risa_r3d.write(frame, os.path.join(UPLOAD_DIR, stem + ".r3d"), frame.get("title"))
            pid = launch(installs[0]["path"], path)
            self._send(200, {"ok": True, "path": path, "pid": pid, "exe": installs[0]["path"]})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        sys.stderr.write("[server] " + fmt % args + "\n")


if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}"
    print(f"RISA-3D control panel running at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
