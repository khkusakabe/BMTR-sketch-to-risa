"""Run the framing agent through Claude Code (headless), using the user's Claude login
instead of an API key.

Claude Code works in a job folder: it looks at the image(s), writes framing.json, runs
cc_check.py (problems + review drawing), looks at review.png next to the original,
fixes the framing and repeats; finally it writes final.json.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import time

import cv2

import plan_agent as pa
import sketch_agent as sa

APP_DIR = os.path.dirname(os.path.abspath(__file__))
TIMEOUT = 25 * 60


def find_claude():
    """The Claude Code executable: $CLAUDE_CODE_EXE, PATH, or the newest VS Code extension copy."""
    if os.environ.get("CLAUDE_CODE_EXE") and os.path.isfile(os.environ["CLAUDE_CODE_EXE"]):
        return os.environ["CLAUDE_CODE_EXE"]
    exe = shutil.which("claude")
    if exe:
        return exe
    pattern = os.path.join(os.path.expanduser("~"), ".vscode", "extensions", "anthropic.claude-code-*",
                           "resources", "native-binary", "claude.exe")
    version = lambda p: [int(x) for x in re.findall(r"claude-code-(\d+)\.(\d+)\.(\d+)", p)[0]]
    found = sorted(glob.glob(pattern), key=version)
    return found[-1] if found else None


PROCEDURE = """
Work in the current folder. Procedure:
1. Look at the input image(s) listed above with the Read tool.
2. Write your framing to framing.json. It must match the JSON schema in schema.json:
   {{"x_grid": [{{"name", "offset_ft"}}], "y_grid": [...], "members": [{{"x1_ft", "y1_ft", "x2_ft", "y2_ft",
   "size", "kind": "girder"|"beam"|"other"}}], "supports": [{{"x_ft", "y_ft"}}], "labels_read": [...], "assumptions": [...]}}
3. Run exactly:  python "{checker}" {mode} .
   It prints the problems it finds and writes review.png, your framing drawn {drawn}.
4. Read review.png and compare it carefully with the original image. Fix framing.json and run the
   checker again. Repeat until {done} and the checker reports no problems (at most 6 rounds).
5. Write final.json: {{"framing": <the final framing>, "remaining_doubts": [<anything you are unsure about>]}}
   Then reply with one short sentence. Do not create any other files.
"""


def _run(workdir, prompt, log):
    exe = find_claude()
    if not exe:
        raise RuntimeError("Claude Code was not found on this PC.")
    with open(os.path.join(workdir, "schema.json"), "w") as f:
        json.dump(sa.Framing.model_json_schema(), f, indent=1)
    for name in ("framing.json", "final.json", "review.png", "progress.log"):
        if os.path.exists(os.path.join(workdir, name)):
            os.remove(os.path.join(workdir, name))
    cmd = [exe, "-p", "--output-format", "json", "--permission-mode", "acceptEdits",
           "--allowedTools", "Read,Write,Edit,Bash(python:*)"]
    log("Claude Code is working (it drafts, checks, looks at its drawing and revises)…")
    proc = subprocess.Popen(cmd, cwd=workdir, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8")
    proc.stdin.write(prompt)
    proc.stdin.close()
    seen, start = 0, time.time()
    progress = os.path.join(workdir, "progress.log")
    while proc.poll() is None:
        time.sleep(2)
        if os.path.exists(progress):
            lines = open(progress).read().splitlines()
            for line in lines[seen:]:
                log("  " + line)
            seen = len(lines)
        if time.time() - start > TIMEOUT:
            proc.kill()
            raise RuntimeError("Claude Code took too long and was stopped.")
    out, err = proc.stdout.read(), proc.stderr.read()
    try:
        result = json.loads(out)
    except ValueError:
        raise RuntimeError(f"Claude Code failed: {(err or out)[-400:]}")
    if result.get("is_error"):
        raise RuntimeError(f"Claude Code reported an error: {result.get('result', '')[:400]}")
    final = os.path.join(workdir, "final.json")
    if not os.path.exists(final):
        raise RuntimeError("Claude Code finished without writing final.json. " + str(result.get("result", ""))[:300])
    with open(final) as f:
        data = json.load(f)
    framing = sa.Framing.model_validate(data["framing"])
    doubts = list(data.get("remaining_doubts", []))
    probs = sa.check(framing, origin_at_zero=False)
    if probs:
        doubts += ["Checker still reports: " + p for p in probs]
    log(f"Claude Code finished: {result.get('result', '').strip()[:200]}")
    return framing, doubts


def run_sketch(upload_dir, stem, log=print):
    """Read a sketch photo (framing, sizes, dimensions) with Claude Code."""
    workdir = os.path.join(upload_dir, stem + "_cc")
    os.makedirs(workdir, exist_ok=True)
    shutil.copy(os.path.join(upload_dir, stem + "_photo.jpg"), os.path.join(workdir, "photo.jpg"))
    with open(os.path.join(upload_dir, stem + "_lines.json")) as f:
        lines = json.load(f)
    prompt = (sa.SYSTEM + "\n\nInput image: photo.jpg (the hand sketch).\n" + sa._cv_hint(lines)
              + PROCEDURE.format(checker=os.path.join(APP_DIR, "cc_check.py"), mode="sketch",
                                 drawn="to scale as a clean plan",
                                 done="the drawing matches the sketch in every line, size and dimension"))
    framing, doubts = _run(workdir, prompt, log)
    return framing, doubts, lines


def run_plan(upload_dir, stem, log=print, instruction=None, current=None):
    """Lay out framing on a PDF plan with Claude Code (or add members the user asked for)."""
    workdir = os.path.join(upload_dir, stem + "_cc")
    os.makedirs(workdir, exist_ok=True)
    meta, img = pa._load(upload_dir, stem)
    cv2.imwrite(os.path.join(workdir, "page.jpg"), pa._small(img), [cv2.IMWRITE_JPEG_QUALITY, 88])
    cv2.imwrite(os.path.join(workdir, "page_full.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    with open(os.path.join(workdir, "plan.json"), "w") as f:
        json.dump(meta, f)
    task = pa._intro(meta).replace("Set satisfied to false on this first draft; you will review it drawn over the plan next.", "")
    if instruction:
        with open(os.path.join(workdir, "current.json"), "w") as f:
            f.write(current.model_dump_json(indent=1))
        task += ("\nA framing already exists in current.json (it includes the user's own edits). "
                 "Start from it, keep everything else as it is, and do what the user asks: " + instruction)
    prompt = (pa.SYSTEM + "\n\nInput image: page.jpg (the floor plan sheet).\n" + task
              + PROCEDURE.format(checker=os.path.join(APP_DIR, "cc_check.py"), mode="plan",
                                 drawn="over the plan (girders blue and thick, beams orange, columns green squares)",
                                 done="you are satisfied nothing is left to improve"))
    framing, doubts = _run(workdir, prompt, log)
    return framing, doubts, meta
