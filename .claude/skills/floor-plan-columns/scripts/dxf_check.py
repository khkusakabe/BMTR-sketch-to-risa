#!/usr/bin/env python3
"""Validate a DXF written by column_tool.js and draw it over the plan underlay.

  python dxf_check.py results/<name>-columns.dxf results/model.json --png results/dxf_check.png

Checks section/table structure, group-code pairing and that every entity's layer
is defined, then prints entity counts per layer and saves a picture of the DXF
geometry drawn over the original drawing (from model.json's underlay).
"""
import argparse, json, math, os, sys
from collections import Counter, defaultdict
import cv2
import numpy as np


def read_pairs(path):
    lines = open(path, encoding="utf-8").read().replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if len(lines) % 2:
        raise SystemExit("FAIL: odd number of lines - group codes and values are not paired")
    pairs = []
    for i in range(0, len(lines), 2):
        try:
            pairs.append((int(lines[i].strip()), lines[i + 1]))
        except ValueError:
            raise SystemExit(f"FAIL: line {i + 1} should be a group code, got {lines[i]!r}")
    return pairs


def parse(pairs):
    errs, sections, layers, ltypes, ents = [], [], set(), set(), []
    i, cur_sec, cur_table = 0, None, None
    cur = None
    for code, val in pairs:
        if code == 0:
            if cur is not None and cur_sec == "ENTITIES":
                ents.append(cur)
            cur = None
            if val == "SECTION":
                if cur_sec:
                    errs.append("SECTION opened inside " + cur_sec)
                cur_sec = "?"
            elif val == "ENDSEC":
                if not cur_sec:
                    errs.append("ENDSEC without SECTION")
                cur_sec = None
            elif val == "TABLE":
                cur_table = "?"
            elif val == "ENDTAB":
                cur_table = None
            elif val == "EOF":
                break
            else:
                cur = {"type": val, "g": defaultdict(list)}
                if cur_sec == "TABLES":
                    cur["table"] = True
        elif code == 2 and cur_sec == "?":
            cur_sec = val; sections.append(val)
        elif code == 2 and cur_table == "?":
            cur_table = val
        elif cur is not None:
            cur["g"][code].append(val)
            if cur.get("table") and code == 2:
                (layers if cur["type"] == "LAYER" else ltypes if cur["type"] == "LTYPE" else set()).add(val)
    if pairs[-1] != (0, "EOF"):
        errs.append("file does not end with 0/EOF")
    return errs, sections, layers, ltypes, ents


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dxf"); ap.add_argument("model", help="model.json (for several wings: the FIRST wing's model)")
    ap.add_argument("--png", default=None)
    ap.add_argument("--pdf", help="the plan PDF: draw the DXF over the whole sheet (use for multi-wing DXFs)")
    ap.add_argument("--page", type=int, default=1)
    a = ap.parse_args()
    pairs = read_pairs(a.dxf)
    errs, sections, layers, ltypes, ents = parse(pairs)
    for need in ("HEADER", "TABLES", "ENTITIES"):
        if need not in sections:
            errs.append("missing section " + need)
    for e in ents:
        lay = e["g"][8][0] if e["g"].get(8) else None
        if lay not in layers:
            errs.append(f"{e['type']} on undefined layer {lay}")
        for c in (10, 20, 11, 21, 40, 39):
            for v in e["g"].get(c, []):
                try:
                    if not math.isfinite(float(v)):
                        raise ValueError
                except ValueError:
                    errs.append(f"{e['type']} has non-numeric group {c}: {v!r}")
    for lay in pairs:
        pass
    print("Sections:", sections, "| layers:", sorted(layers), "| linetypes:", sorted(ltypes))
    cnt = Counter((e["g"][8][0], e["type"] + ("(3D)" if e["g"].get(39) else "")) for e in ents)
    for (lay, t), n in sorted(cnt.items()):
        print(f"  {lay:12s} {t:12s} {n}")
    if errs:
        print("FAIL:", *sorted(set(errs))[:20], sep="\n  ")
        sys.exit(1)
    print("Structure OK")

    if not a.png:
        return
    model = json.load(open(a.model))
    xs, ys = [], []
    for e in ents:
        for cx, cy in ((10, 20), (11, 21)):
            if e["g"].get(cx):
                xs.append(float(e["g"][cx][0])); ys.append(float(e["g"][cy][0]))
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    pad = 0.04 * max(maxx - minx, maxy - miny)
    minx, maxx, miny, maxy = minx - pad, maxx + pad, miny - pad, maxy + pad
    S = 2200 / max(maxx - minx, maxy - miny)
    Wpx, Hpx = int((maxx - minx) * S), int((maxy - miny) * S)
    img = np.full((Hpx, Wpx, 3), 255, np.uint8)
    P = lambda x, y: (int((x - minx) * S), int((maxy - y) * S))
    u = model.get("underlay")
    up = os.path.join(os.path.dirname(a.model), u["file"]) if u else None
    fr = model.get("frame") or {}
    if a.pdf and fr.get("inPerPt"):
        # building coords (relative to the first wing's origin) <-> sheet points
        import pdfplumber
        z = 100 / 72.0
        sheet = np.array(pdfplumber.open(a.pdf).pages[a.page - 1].to_image(resolution=100).original.convert("RGB"))[:, :, ::-1]
        k = fr["inPerPt"]; s_ = S * k / z
        Maff = np.float32([[s_, 0, -(fr["ox"] + minx) * S], [0, s_, (maxy + fr["oy"]) * S]])
        under = cv2.warpAffine(sheet, Maff, (Wpx, Hpx), borderValue=(255, 255, 255))
        img[:] = (under * 0.5 + 255 * 0.5).astype(np.uint8)
        up = None
    if up and os.path.exists(up):
        under = cv2.imread(up)
        (ax, ay), (bx, by) = P(u["x0"], u["y1"]), P(u["x1"], u["y0"])
        under = cv2.resize(under, (max(1, bx - ax), max(1, by - ay)))
        x0, y0 = max(0, ax), max(0, ay)
        x1, y1 = min(Wpx, bx), min(Hpx, by)
        if x1 > x0 and y1 > y0:
            region = under[y0 - ay:y1 - ay, x0 - ax:x1 - ax]
            img[y0:y1, x0:x1] = (region * 0.5 + 255 * 0.5).astype(np.uint8)
    color = {"S-GRID": (200, 140, 40), "S-GRID-IDEN": (200, 140, 40), "S-ANNO-DIMS": (40, 150, 40), "A-WALL-REF": (150, 150, 150),
             "A-OPEN": (40, 140, 240), "S-COLS": (120, 120, 0), "S-COLS-NEW": (30, 30, 220), "S-COLS-IDEN": (30, 30, 30), "S-COLS-3D": (120, 120, 0),
             "S-FRAM-GIRD": (130, 40, 140), "S-FRAM-BEAM": (180, 110, 50), "S-FRAM-IDEN": (90, 30, 100)}
    for e in ents:
        g, lay = e["g"], e["g"][8][0]
        c = color.get(lay, (0, 0, 0))
        if e["type"] == "LINE":
            cv2.line(img, P(float(g[10][0]), float(g[20][0])), P(float(g[11][0]), float(g[21][0])), c, 3 if lay == "S-FRAM-GIRD" else 1, cv2.LINE_AA)
        elif e["type"] == "CIRCLE" and not g.get(39):
            r = max(2, int(float(g[40][0]) * S))
            cv2.circle(img, P(float(g[10][0]), float(g[20][0])), r, c, 2 if lay.startswith("S-COLS") else 1, cv2.LINE_AA)
        elif e["type"] == "TEXT":
            h = float(g[40][0]) * S
            x, y = float(g[10][0]), float(g[20][0])
            px, py = P(x, y)
            fs = max(0.35, h / 22)
            (tw, th), _ = cv2.getTextSize(g[1][0], cv2.FONT_HERSHEY_SIMPLEX, fs, 1)
            if g.get(72):
                px -= tw // 2
            if g.get(50) and abs(float(g[50][0]) - 90) < 1:
                continue  # rotated dimension text: skip in preview
            cv2.putText(img, g[1][0], (px, py), cv2.FONT_HERSHEY_SIMPLEX, fs, c, 1, cv2.LINE_AA)
    cv2.imwrite(a.png, img)
    print("Picture:", a.png)


if __name__ == "__main__":
    main()
