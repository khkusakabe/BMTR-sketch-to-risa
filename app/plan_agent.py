"""Lay out steel floor framing on an architectural PDF plan with a Claude agent.

The PDF page is rendered at the user's scale, so every pixel maps to real feet.
Coordinates the agent uses are feet measured on the sheet from its top-left corner
(x right, y down). Loop: draft -> code checks + framing drawn over the plan ->
the agent reviews the overlay and revises -> ... (MAX_ROUNDS). Afterwards the user
can ask for more members; that continues the same conversation.
"""
import base64
import json
import os

import cv2
import numpy as np
from pydantic import BaseModel
from typing import List

import sketch_agent as sa
from sketch_agent import Framing

AGENT_PX = 1568          # long side of images sent to the model
SESSIONS = {}            # stem -> {"messages": [...], "framing": Framing}


class DesignReply(BaseModel):
    framing: Framing
    satisfied: bool
    remaining_doubts: List[str]


SYSTEM = """You are an experienced structural engineer laying out preliminary steel floor framing
(composite metal deck on steel beams) for the architectural floor plan in the image.

Coordinates are feet at the drawing scale, measured from the top-left corner of the sheet:
x to the right, y downward. The sheet size in feet is given. Grid line offsets are absolute
sheet coordinates (a vertical grid line at offset 32.5 is the line x = 32.5).

Lay out the framing:
- Find the building footprint, exterior walls, interior bearing/corridor walls, and openings
  (stairs, elevators, shafts, atria).
- Use the plan's own column grid if one is drawn, with its labels. Otherwise create one
  (vertical lines 1, 2, 3... from the left; horizontal lines A, B, C... from the top) with
  regular bays of about 20-35 ft that fit the walls.
- Columns (supports) at grid intersections inside or on the building outline, preferably in
  walls or at wall corners, never in the middle of a room, corridor or doorway.
- Girders along one grid direction between columns; beams spanning the other way at no more
  than about 10 ft spacing, framing into girders; edge beams/girders along the whole perimeter.
- Frame every opening on all sides; nothing crosses an opening.
- Every member runs between two adjacent connection points (split girders where beams frame
  in) and both of its ends land on another member or a column.
- Preliminary AISC W sizes (write them like W16X26) from rules of thumb for composite floors:
  beam depth in inches about span in feet / 2 (e.g. 30 ft -> W16 to W18), girders 1-2 sizes
  deeper than the beams they carry. Use only real AISC W shapes.
- In labels_read list the grid labels, dimensions and room names you relied on, and in
  assumptions list your design assumptions (loads, deck, bay choices)."""


# ---------------------------------------------------------------- the PDF ----
def prepare(pdf_path, page_no, ratio, out_stem):
    """Render the page at scale and pull its text with positions in sheet feet."""
    import fitz
    doc = fitz.open(pdf_path)
    page = doc[page_no - 1]
    long_pt = max(page.rect.width, page.rect.height)
    zoom = min(200 / 72, 3000 / long_pt)               # <= 200 dpi, <= 3000 px
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    cv2.imwrite(out_stem + "_page.jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])

    ft_per_pt = ratio / 72 / 12
    words = []
    for x0, y0, x1, y1, w, *_ in page.get_text("words"):
        r = fitz.Rect(x0, y0, x1, y1) * page.rotation_matrix
        words.append({"text": w, "x": round((r.x0 + r.x1) / 2 * ft_per_pt, 2),
                      "y": round((r.y0 + r.y1) / 2 * ft_per_pt, 2)})
    # zoom = image px per PDF point; ft_per_pt = real feet per PDF point at this scale.
    meta = {"width": pix.width, "height": pix.height, "px_per_ft": zoom / ft_per_pt,
            "sheet_ft": [round(pix.width / zoom * ft_per_pt, 2), round(pix.height / zoom * ft_per_pt, 2)],
            "words": words}
    with open(out_stem + "_plan.json", "w") as f:
        json.dump(meta, f)
    return meta


def _load(upload_dir, stem):
    with open(os.path.join(upload_dir, stem + "_plan.json")) as f:
        meta = json.load(f)
    img = cv2.imread(os.path.join(upload_dir, stem + "_page.jpg"))
    return meta, img


def _small(img):
    s = AGENT_PX / max(img.shape[:2])
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img


def _jpg_block(img):
    data = cv2.imencode(".jpg", _small(img), [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.standard_b64encode(data).decode()}}


def overlay(fr: Framing, meta, img):
    """The framing drawn over the plan, for the agent's review and for checking by eye."""
    k = meta["px_per_ft"]
    out = cv2.addWeighted(img, 0.55, np.full_like(img, 255), 0.45, 0)
    P = lambda x, y: (int(x * k), int(y * k))
    th = max(2, int(max(img.shape[:2]) / 700))
    font = cv2.FONT_HERSHEY_SIMPLEX
    fs = max(0.5, max(img.shape[:2]) / 3000)
    H, W = img.shape[:2]
    for g in fr.x_grid:
        cv2.line(out, (int(g.offset_ft * k), 0), (int(g.offset_ft * k), H), (160, 160, 160), 1)
        cv2.putText(out, g.name, (int(g.offset_ft * k) + 4, int(30 * fs)), font, fs, (90, 90, 90), 2)
    for g in fr.y_grid:
        cv2.line(out, (0, int(g.offset_ft * k)), (W, int(g.offset_ft * k)), (160, 160, 160), 1)
        cv2.putText(out, g.name, (4, int(g.offset_ft * k) - 4), font, fs, (90, 90, 90), 2)
    for m in fr.members:
        p, q = P(m.x1_ft, m.y1_ft), P(m.x2_ft, m.y2_ft)
        girder = m.kind == "girder"
        cv2.line(out, p, q, (200, 90, 20) if girder else (40, 120, 230), th * (2 if girder else 1), cv2.LINE_AA)
        cv2.putText(out, m.size, ((p[0] + q[0]) // 2 + 4, (p[1] + q[1]) // 2 - 4), font, fs * 0.7,
                    (20, 20, 160), 1, cv2.LINE_AA)
    for s in fr.supports:
        x, y = P(s.x_ft, s.y_ft)
        r = th * 4
        cv2.rectangle(out, (x - r, y - r), (x + r, y + r), (30, 140, 30), th)
    return out


def _intro(meta):
    words = meta["words"][:600]
    text = "\n".join(f"  {w['text']} @ ({w['x']}, {w['y']})" for w in words)
    return (f"The sheet is {meta['sheet_ft'][0]} ft wide and {meta['sheet_ft'][1]} ft tall at the drawing scale.\n"
            + (f"Text on the sheet with positions in feet ({len(words)} words):\n{text}\n" if words else
               "The sheet has no extractable text (scanned drawing).\n")
            + "\nLay out the complete floor framing. Set satisfied to false on this first draft; "
              "you will review it drawn over the plan next.")


def _review_msg(fr, meta, img, probs, extra=""):
    return {"role": "user", "content": [
        _jpg_block(overlay(fr, meta, img)),
        {"type": "text", "text": (
            "Above is your framing drawn over the plan (girders blue and thick, beams orange, columns green "
            "squares, grid grey). Review it as a checking engineer: columns not in rooms/corridors/doors, "
            "every opening framed, beam spacing and spans reasonable, sizes consistent with spans, "
            "nothing missing along the perimeter, every member supported.\n"
            + ("Automatic checks found:\n- " + "\n- ".join(probs) if probs else "Automatic checks found no problems.")
            + (("\n" + extra) if extra else "")
            + "\nReturn the improved complete framing. Set satisfied true only if nothing is left to improve.")},
    ]}


def _loop(client, sess, meta, img, rounds, log, first_label):
    reply = None
    for rnd in range(1, rounds + 1):
        log(f"Round {rnd}: {first_label if rnd == 1 else 'reviewing its framing drawn over the plan'}…")
        resp = client.beta.messages.parse(
            model=sa.MODEL, max_tokens=16000, system=SYSTEM, messages=sess["messages"],
            output_format=DesignReply, output_config={"effort": "high"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            raise RuntimeError("The model declined this request.")
        if resp.stop_reason == "max_tokens" or resp.parsed_output is None:
            raise RuntimeError("The model's answer was cut off; try again.")
        reply = resp.parsed_output
        sess["messages"].append({"role": "assistant", "content": resp.content})
        sess["framing"] = reply.framing
        probs = sa.check(reply.framing, origin_at_zero=False)
        fr = reply.framing
        log(f"  {len(fr.members)} members, {len(fr.supports)} columns, grid {len(fr.x_grid)}×{len(fr.y_grid)}; "
            f"{len(probs)} problem(s) from the checker" + ("; agent is satisfied" if reply.satisfied else ""))
        for p in probs[:6]:
            log("   - " + p)
        if rnd > 1 and reply.satisfied and not probs:
            return reply
        if rnd < rounds:
            sess["messages"].append(_review_msg(fr, meta, img, probs))
    reply.remaining_doubts.append("Stopped after the maximum number of review rounds.")
    return reply


def run_design(upload_dir, stem, log=print, rounds=sa.MAX_ROUNDS):
    import anthropic
    meta, img = _load(upload_dir, stem)
    client = anthropic.Anthropic(api_key=sa.get_key())
    sess = SESSIONS[stem] = {"messages": [{"role": "user", "content": [_jpg_block(img), {"type": "text", "text": _intro(meta)}]}]}
    return _loop(client, sess, meta, img, rounds, log, "studying the plan and laying out framing"), meta


def run_more(upload_dir, stem, instruction, current: Framing, log=print):
    """User asked for more members: continue the conversation from the current framing."""
    import anthropic
    meta, img = _load(upload_dir, stem)
    client = anthropic.Anthropic(api_key=sa.get_key())
    sess = SESSIONS.get(stem)
    if not sess:  # server restarted: start a fresh conversation around the current framing
        sess = SESSIONS[stem] = {"messages": [{"role": "user", "content": [_jpg_block(img), {"type": "text", "text": _intro(meta)}]}]}
        sess["messages"][0]["content"][1]["text"] += "\n(A framing already exists; it follows.)"
        sess["messages"].append({"role": "assistant", "content": "Understood."})
    sess["messages"].append(_review_msg(current, meta, img, sa.check(current, origin_at_zero=False), extra=(
        "This is the current framing, including the user's own edits:\n" + current.model_dump_json()
        + "\n\nThe user asks: " + instruction + "\nKeep everything else as it is unless the request needs a change.")))
    return _loop(client, sess, meta, img, 2, log, "adding the requested members"), meta


# ------------------------------------------------------- editor conversion ----
def to_editor(fr: Framing, meta, photo_url, stem):
    k = meta["px_per_ft"]
    nodes, key = [], {}

    def nid(x, y):
        kk = (round(x, 3), round(y, 3))
        if kk not in key:
            key[kk] = len(nodes) + 1
            nodes.append({"id": key[kk], "x": round(x * k, 1), "y": round(y * k, 1)})
        return key[kk]

    members = [{"id": i, "i": nid(m.x1_ft, m.y1_ft), "j": nid(m.x2_ft, m.y2_ft), "size": m.size.upper().replace(" ", "")}
               for i, m in enumerate(fr.members, 1)]
    xo = [g.offset_ft for g in fr.x_grid]
    yo = [g.offset_ft for g in fr.y_grid]
    return {"width": meta["width"], "height": meta["height"], "photo": photo_url, "stem": stem,
            "grid": {"x": [v * k for v in xo], "y": [v * k for v in yo]},
            "dx": [b - a for a, b in zip(xo, xo[1:])], "dy": [b - a for a, b in zip(yo, yo[1:])],
            "nodes": nodes, "members": members, "supports": [nid(s.x_ft, s.y_ft) for s in fr.supports],
            "tol": 0.5 * k, "snap": 1.0 * k}


def from_editor(state, meta):
    """Editor state (pixels) -> Framing in sheet feet, so the agent sees the user's edits."""
    k = meta["px_per_ft"]
    nodes = {n["id"]: n for n in state["nodes"]}
    return Framing(
        x_grid=[sa.GridLine(name=str(i + 1), offset_ft=round(v / k, 2)) for i, v in enumerate(state["gx"])],
        y_grid=[sa.GridLine(name=chr(65 + i), offset_ft=round(v / k, 2)) for i, v in enumerate(state["gy"])],
        members=[sa.Member(x1_ft=round(nodes[m["i"]]["x"] / k, 2), y1_ft=round(nodes[m["i"]]["y"] / k, 2),
                           x2_ft=round(nodes[m["j"]]["x"] / k, 2), y2_ft=round(nodes[m["j"]]["y"] / k, 2),
                           size=m["size"] or "W8X10", kind="beam") for m in state["members"]],
        supports=[sa.Support(x_ft=round(n["x"] / k, 2), y_ft=round(n["y"] / k, 2)) for n in state["nodes"] if n.get("sup")],
        labels_read=[], assumptions=[])
