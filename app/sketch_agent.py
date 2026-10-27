"""Read a framing sketch: offline OCR first, then a Claude agent that drafts the
framing, checks its own drawing against the photo, and redoes it until it matches.

Agent loop (code-controlled, append-only conversation):
  1. Claude gets the photo + the line work found by sketch.py and returns a framing
     (grid spacings in feet, members with sizes, supports) as structured output.
  2. We check it in code (connectivity, real AISC shapes, sane grid) and render it
     as a drawing.
  3. Claude compares the drawing with the photo, plus our check results, and returns
     a corrected framing and a verdict. Repeat until it matches or MAX_ROUNDS.
"""
import base64
import json
import os
import re
from typing import List, Literal

import cv2
import numpy as np
from pydantic import BaseModel

APP_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL = "claude-opus-5-5"
MAX_ROUNDS = 4
CONFIG = os.path.join(os.environ.get("APPDATA", APP_DIR), "RISA-Control-Panel", "config.json")

with open(os.path.join(APP_DIR, "templates", "w_shapes.json")) as f:
    W_SHAPES = set(json.load(f))
SIZE_RE = re.compile(r"^W\d+X\d+(\.\d+)?$")


# ---------------------------------------------------------------- API key ----
def get_key():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]
    try:
        with open(CONFIG) as f:
            return json.load(f).get("anthropic_api_key")
    except (OSError, ValueError):
        return None


def save_key(key):
    """Check the key with a cheap call, then store it in the user's AppData."""
    import anthropic
    anthropic.Anthropic(api_key=key).models.retrieve(MODEL)
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    with open(CONFIG, "w") as f:
        json.dump({"anthropic_api_key": key}, f)


# -------------------------------------------------------------------- OCR ----
_reader = None


def ocr_labels(photo_bytes):
    """Offline OCR (EasyOCR) of sizes and dimensions. Returns what it could read."""
    global _reader
    import easyocr
    if _reader is None:
        _reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    img = cv2.imdecode(np.frombuffer(photo_bytes, np.uint8), cv2.IMREAD_COLOR)
    sizes, dims = [], []
    for box, text, conf in _reader.readtext(img, rotation_info=[90, 180, 270], min_size=20):
        t = text.upper().replace(" ", "").replace("×", "X")
        cx, cy = float(np.mean([p[0] for p in box])), float(np.mean([p[1] for p in box]))
        if SIZE_RE.match(t) and t in W_SHAPES and conf > 0.4:
            sizes.append({"text": t, "conf": round(conf, 2), "x": cx, "y": cy})
        elif re.match(r"^\d+(\.\d+)?('|FT)$", t) and conf > 0.4:
            dims.append({"text": t, "conf": round(conf, 2), "x": cx, "y": cy})
    return {"sizes": sizes, "dims": dims}


def ocr_sizes_to_members(ocr, lines):
    """Give each size OCR read to the nearest detected member: {member_id: size}."""
    nodes = {n["id"]: n for n in lines["nodes"]}
    out = {}
    for s in ocr["sizes"]:
        best, bd = None, float("inf")
        for m in lines["members"]:
            a, b = nodes[m["i"]], nodes[m["j"]]
            ab = np.array([b["x"] - a["x"], b["y"] - a["y"]]); L2 = float(ab @ ab) or 1
            t = np.clip(((s["x"] - a["x"]) * ab[0] + (s["y"] - a["y"]) * ab[1]) / L2, 0, 1)
            d = np.hypot(a["x"] + t * ab[0] - s["x"], a["y"] + t * ab[1] - s["y"])
            if d < bd:
                best, bd = m["id"], d
        if best is not None:
            out[best] = s["text"]
    return out


def ocr_is_enough(ocr, members):
    """OCR is usable only if it found a size for most member groups and some dims."""
    return len(ocr["sizes"]) >= max(1, len(members) // 6) and len(ocr["dims"]) >= 2


# ----------------------------------------------------------------- schema ----
class GridLine(BaseModel):
    name: str
    offset_ft: float


class Member(BaseModel):
    x1_ft: float
    y1_ft: float
    x2_ft: float
    y2_ft: float
    size: str
    kind: Literal["girder", "beam", "other"]


class Support(BaseModel):
    x_ft: float
    y_ft: float


class Framing(BaseModel):
    x_grid: List[GridLine]
    y_grid: List[GridLine]
    members: List[Member]
    supports: List[Support]
    labels_read: List[str]
    assumptions: List[str]


class AgentReply(BaseModel):
    framing: Framing
    matches_sketch: bool
    remaining_doubts: List[str]


SYSTEM = """You turn photos of hand-sketched steel floor framing plans into exact framing data for RISA-3D.

Coordinates: plan feet. x runs left to right across the photo as shown, y runs top to bottom down the photo.
Vertical grid lines are named 1, 2, 3... from the left; horizontal grid lines A, B, C... from the top.
The first grid line in each direction is at offset 0; offsets are cumulative feet.

How to read the sketch:
- Lengths come only from the dimensions written on the sketch, never from measuring the drawing (it is not to scale).
  An overall dimension along a side covers the whole side; split it into the bays it spans. If beams in a bay are
  drawn roughly evenly and no spacing is written, assume equal spacing and say so in assumptions.
- Sizes are AISC wide flanges written like W21x55. "do" or a ditto mark means same size as the labelled member
  next to it. A label written along a line belongs to that line. Text may be rotated or upside down.
- Small boxes or squares at line intersections are columns: put a support there.
- Every beam must frame into a girder or support at both ends, even where the sketch stops the line short.
- Write sizes as RISA spells them: W14X22 (capital X). Use only real AISC W shapes.
- In labels_read list every piece of text you read and where it is. In assumptions list anything you inferred.

Each member runs between two adjacent connection points (split girders where beams frame in)."""


def _img_block(data, mime):
    return {"type": "image", "source": {"type": "base64", "media_type": mime,
                                        "data": base64.standard_b64encode(data).decode()}}


def _cv_hint(lines):
    """Describe the line work sketch.py found, in grid terms, as a topology hint."""
    gx, gy = lines["grid"]["x"], lines["grid"]["y"]
    name = lambda v, g, f: f(min(range(len(g)), key=lambda k: abs(g[k] - v))) if g else "?"
    nodes = {n["id"]: n for n in lines["nodes"]}
    out = [f"Computer vision found {len(gx)} vertical and {len(gy)} horizontal grid lines and these members "
           "(may be incomplete or include stray marks):"]
    for m in lines["members"]:
        a, b = nodes[m["i"]], nodes[m["j"]]
        pa = name(a["x"], gx, lambda k: str(k + 1)) + "/" + name(a["y"], gy, lambda k: chr(65 + k))
        pb = name(b["x"], gx, lambda k: str(k + 1)) + "/" + name(b["y"], gy, lambda k: chr(65 + k))
        out.append(f"  {pa} to {pb}")
    return "\n".join(out)


# ------------------------------------------------------------------ checks ----
def check(fr: Framing, origin_at_zero=True):
    """Problems found in code. Empty list = consistent."""
    probs = []
    for axis, g in (("vertical", fr.x_grid), ("horizontal", fr.y_grid)):
        offs = [l.offset_ft for l in g]
        if origin_at_zero and offs and offs[0] != 0:
            probs.append(f"First {axis} grid line must be at 0 ft.")
        if any(b <= a for a, b in zip(offs, offs[1:])):
            probs.append(f"{axis.capitalize()} grid offsets must increase.")
    for k, m in enumerate(fr.members, 1):
        s = m.size.upper().replace(" ", "")
        if not SIZE_RE.match(s):
            probs.append(f"Member {k} size '{m.size}' is not a W shape.")
        elif s not in W_SHAPES:
            probs.append(f"Member {k} size {s} is not a real AISC shape (check the handwriting, e.g. W12X14 vs W14X12).")
        if abs(m.x1_ft - m.x2_ft) < 1e-6 and abs(m.y1_ft - m.y2_ft) < 1e-6:
            probs.append(f"Member {k} has zero length.")
    # Every member end must land on another member or a support.
    pts = [(s.x_ft, s.y_ft) for s in fr.supports]
    segs = [((m.x1_ft, m.y1_ft), (m.x2_ft, m.y2_ft)) for m in fr.members]
    for k, (p, q) in enumerate(segs, 1):
        for end in (p, q):
            ok = any(np.hypot(end[0] - s[0], end[1] - s[1]) < 0.1 for s in pts)
            for j, (a, b) in enumerate(segs, 1):
                if ok or j == k:
                    continue
                ab = np.subtract(b, a); L2 = float(ab @ ab)
                t = float(np.subtract(end, a) @ ab) / L2 if L2 else 0
                d = np.hypot(*(np.add(a, np.clip(t, 0, 1) * ab) - np.array(end)))
                ok = d < 0.1
            if not ok:
                probs.append(f"Member {k} end at ({end[0]:g}, {end[1]:g}) ft is not connected to anything.")
    return probs


# ------------------------------------------------------------------ render ----
def render(fr: Framing, px_per_ft=None):
    """Draw the framing as a clean plan (PNG bytes) for the visual self-check."""
    xs = [l.offset_ft for l in fr.x_grid] or [0]
    ys = [l.offset_ft for l in fr.y_grid] or [0]
    W, H = max(xs + [m.x2_ft for m in fr.members] + [m.x1_ft for m in fr.members]), \
        max(ys + [m.y2_ft for m in fr.members] + [m.y1_ft for m in fr.members])
    s = px_per_ft or min(1100 / max(W, 1), 1300 / max(H, 1))
    M = 120
    img = np.full((int(H * s) + 2 * M, int(W * s) + 2 * M, 3), 255, np.uint8)
    P = lambda x, y: (int(M + x * s), int(M + y * s))
    font = cv2.FONT_HERSHEY_SIMPLEX
    for l in fr.x_grid:
        cv2.line(img, P(l.offset_ft, 0), P(l.offset_ft, H), (200, 200, 200), 1)
        cv2.circle(img, (P(l.offset_ft, 0)[0], 40), 18, (90, 90, 90), 2)
        cv2.putText(img, l.name, (P(l.offset_ft, 0)[0] - 8, 47), font, 0.6, (60, 60, 60), 2)
    for l in fr.y_grid:
        cv2.line(img, P(0, l.offset_ft), P(W, l.offset_ft), (200, 200, 200), 1)
        cv2.circle(img, (40, P(0, l.offset_ft)[1]), 18, (90, 90, 90), 2)
        cv2.putText(img, l.name, (32, P(0, l.offset_ft)[1] + 7), font, 0.6, (60, 60, 60), 2)
    for a, b in zip(fr.x_grid, fr.x_grid[1:]):  # spacing dimensions
        cv2.putText(img, f"{b.offset_ft - a.offset_ft:g}'", ((P(a.offset_ft, 0)[0] + P(b.offset_ft, 0)[0]) // 2 - 15, 85),
                    font, 0.6, (0, 90, 200), 2)
    for a, b in zip(fr.y_grid, fr.y_grid[1:]):
        cv2.putText(img, f"{b.offset_ft - a.offset_ft:g}'", (70, (P(0, a.offset_ft)[1] + P(0, b.offset_ft)[1]) // 2),
                    font, 0.6, (0, 90, 200), 2)
    for m in fr.members:
        p, q = P(m.x1_ft, m.y1_ft), P(m.x2_ft, m.y2_ft)
        cv2.line(img, p, q, (190, 80, 20) if m.kind == "girder" else (40, 40, 40), 4 if m.kind == "girder" else 2)
        mid = ((p[0] + q[0]) // 2, (p[1] + q[1]) // 2)
        cv2.putText(img, m.size, (mid[0] + 6, mid[1] - 6), font, 0.5, (20, 20, 160), 1, cv2.LINE_AA)
    for sp in fr.supports:
        x, y = P(sp.x_ft, sp.y_ft)
        cv2.rectangle(img, (x - 9, y - 9), (x + 9, y + 9), (30, 140, 30), 2)
    return cv2.imencode(".png", img)[1].tobytes()


# ------------------------------------------------------------------- agent ----
def run_agent(photo_jpg, lines, log=print):
    """Draft -> check -> redo loop. Returns (Framing, doubts list, rounds used)."""
    import anthropic
    client = anthropic.Anthropic(api_key=get_key())
    messages = [{"role": "user", "content": [
        _img_block(photo_jpg, "image/jpeg"),
        {"type": "text", "text": _cv_hint(lines) + "\n\nRead this framing sketch and return the complete framing. "
                                 "Set matches_sketch to false on this first draft; you will check it next."},
    ]}]
    reply = None
    for rnd in range(1, MAX_ROUNDS + 1):
        log(f"Round {rnd}: {'reading the sketch' if rnd == 1 else 'comparing its drawing with the photo'}…")
        resp = client.beta.messages.parse(
            model=MODEL, max_tokens=16000, system=SYSTEM, messages=messages,
            output_format=AgentReply, output_config={"effort": "high"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            raise RuntimeError("The model declined to read this image.")
        if resp.stop_reason == "max_tokens" or resp.parsed_output is None:
            raise RuntimeError("The model's answer was cut off; try again.")
        reply = resp.parsed_output
        messages.append({"role": "assistant", "content": resp.content})

        probs = check(reply.framing)
        fr = reply.framing
        log(f"  {len(fr.members)} members, grid {len(fr.x_grid)}×{len(fr.y_grid)}; "
            f"{len(probs)} problem(s) found by the checker"
            + ("; model says it matches the sketch" if reply.matches_sketch else ""))
        for p in probs[:6]:
            log("   - " + p)
        if rnd > 1 and reply.matches_sketch and not probs:
            return reply.framing, reply.remaining_doubts, rnd
        messages.append({"role": "user", "content": [
            _img_block(render(fr), "image/png"),
            {"type": "text", "text": (
                "Above is your framing drawn to scale (grid bubbles, spacings in orange, sizes in red, "
                "girders thick and blue, supports as green squares). Compare it carefully with the original photo: "
                "every line, every size label, every written dimension, and the column locations.\n"
                + ("Automatic checks found these problems:\n- " + "\n- ".join(probs) if probs
                   else "Automatic checks found no problems.")
                + "\nReturn the corrected complete framing. Set matches_sketch true only if the drawing now "
                  "matches the sketch in every respect.")},
        ]})
    return reply.framing, reply.remaining_doubts + ["Stopped after the maximum number of rounds."], MAX_ROUNDS


# ------------------------------------------------------- to editor format ----
def to_editor(fr: Framing, lines):
    """Convert the agent's framing (feet) into the editor's pixel format, laid over
    the photo when the grid counts match what computer vision found."""
    xo = [l.offset_ft for l in fr.x_grid]
    yo = [l.offset_ft for l in fr.y_grid]
    gx, gy = lines["grid"]["x"], lines["grid"]["y"]
    w, h = lines["width"], lines["height"]

    def mapper(offs, g, size):
        if len(g) == len(offs) and len(g) > 1:
            return lambda v: float(np.interp(v, offs, g, left=None, right=None)) if offs[0] <= v <= offs[-1] \
                else g[0] + (v - offs[0]) * (g[-1] - g[0]) / (offs[-1] - offs[0])
        span = (offs[-1] - offs[0]) or 1
        return lambda v: size * 0.12 + (v - offs[0]) / span * size * 0.76

    mx, my = mapper(xo, gx, w), mapper(yo, gy, h)
    nodes, key = [], {}

    def nid(x, y):
        k = (round(x, 3), round(y, 3))
        if k not in key:
            key[k] = len(nodes) + 1
            nodes.append({"id": key[k], "x": round(mx(x), 1), "y": round(my(y), 1)})
        return key[k]

    members = [{"id": k, "i": nid(m.x1_ft, m.y1_ft), "j": nid(m.x2_ft, m.y2_ft),
                "size": m.size.upper().replace(" ", "")} for k, m in enumerate(fr.members, 1)]
    supports = [nid(s.x_ft, s.y_ft) for s in fr.supports]
    return {
        **{k: lines[k] for k in ("width", "height", "photo", "stem", "name") if k in lines},
        "grid": {"x": [round(mx(v), 1) for v in xo], "y": [round(my(v), 1) for v in yo]},
        "grid_names": {"x": [l.name for l in fr.x_grid], "y": [l.name for l in fr.y_grid]},
        "dx": [b - a for a, b in zip(xo, xo[1:])], "dy": [b - a for a, b in zip(yo, yo[1:])],
        "nodes": nodes, "members": members, "supports": supports,
    }
