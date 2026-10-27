#!/usr/bin/env python3
"""Locate circular columns on a PDF floor plan.

Works on both vector PDFs (CAD/Revit exports) and scanned/raster PDFs.
Finds every circle on the page, separates grid bubbles and labelled tags
from plain circles, reads the structural grid, picks out the circles that
behave like columns, and writes:

  <out>/columns.json      everything found (for Claude to review)
  <out>/columns.csv       one row per column
  <out>/columns.xlsx      formatted spreadsheet (Columns / Grid / Other circles / Summary)
  <out>/overlay.png       whole sheet with findings marked
  <out>/overlay_tile_*.png  zoomed tiles of the plan area for close checking

Usage:
  python find_columns.py plan.pdf --out results/ [--page 1] [--scale "1/8in=1ft" | "1:100"]
         [--mode auto|vector|raster] [--min-dia 3] [--max-dia 72] [--column-dia 18]
         [--include ID ...] [--exclude ID ...] [--units ft|m]

Coordinates are PDF points (1/72 in) measured from the TOP-LEFT of the page.
--min-dia/--max-dia/--column-dia are in PDF points as drawn on the sheet.
"""
import argparse, csv, json, math, os, re, subprocess, sys
from collections import Counter, defaultdict

import numpy as np
import cv2
import pdfplumber

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # helper modules beside this script

# ----------------------------------------------------------------- geometry

def fit_circle(pts):
    """Least-squares (Kasa) circle fit. Returns cx, cy, r, rms_residual."""
    p = np.asarray(pts, float)
    if len(p) < 3:
        return None
    A = np.c_[2 * p[:, 0], 2 * p[:, 1], np.ones(len(p))]
    b = (p ** 2).sum(1)
    try:
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    except np.linalg.LinAlgError:
        return None
    cx, cy, c = sol
    r2 = c + cx * cx + cy * cy
    if r2 <= 0:
        return None
    r = math.sqrt(r2)
    res = np.sqrt(((p - [cx, cy]) ** 2).sum(1)) - r
    return cx, cy, r, float(np.sqrt((res ** 2).mean()))


def angular_coverage(pts, cx, cy, max_gap=20.0):
    """Degrees of the circle traced by pts (ignoring gaps smaller than max_gap degrees)."""
    p = np.asarray(pts, float)
    ang = np.sort((np.degrees(np.arctan2(p[:, 1] - cy, p[:, 0] - cx)) + 360) % 360)
    if len(ang) < 2:
        return 0.0
    gaps = np.diff(np.r_[ang, ang[0] + 360])
    return float(360 - gaps[gaps > max_gap].sum())


def sample_path(path):
    """Turn a pdfplumber path into sub-paths of densely sampled points."""
    subs, cur, start, last = [], [], None, None
    for op in path:
        kind = op[0]
        if kind == "m":
            if len(cur) > 1:
                subs.append(cur)
            cur = [op[1]]; start = last = op[1]
        elif kind == "l":
            p0, p1 = last, op[1]
            n = max(2, int(math.dist(p0, p1) / 1.5))
            cur += [(p0[0] + (p1[0] - p0[0]) * t / n, p0[1] + (p1[1] - p0[1]) * t / n) for t in range(1, n + 1)]
            last = op[1]
        elif kind == "c":
            p0, c1, c2, p3 = last, op[1], op[2], op[3]
            for i in range(1, 13):
                t = i / 12; u = 1 - t
                cur.append((u**3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t**3 * p3[0],
                            u**3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t**3 * p3[1]))
            last = p3
        elif kind == "h" and start is not None:
            cur.append(start); last = start
    if len(cur) > 1:
        subs.append(cur)
    return subs

# ----------------------------------------------------------------- vector pass

def vector_circles(page, min_d, max_d):
    circles, arcs = [], []
    objs = list(page.curves) + [o for o in page.objects.get("curve", []) if o not in page.curves]
    for obj in page.curves:
        if not obj.get("path"):
            continue
        fill = bool(obj.get("fill"))
        for sub in sample_path(obj["path"]):
            if len(sub) < 8:
                continue
            f = fit_circle(sub)
            if not f:
                continue
            cx, cy, r, rms = f
            if not (min_d / 2 <= r <= max_d / 2) or rms > 0.04 * r + 0.15:
                continue
            cov = angular_coverage(sub, cx, cy)
            item = dict(x=cx, y=cy, r=r, fill="solid" if fill else "outline", src="vector", coverage=cov, pts=sub)
            (circles if cov >= 330 else arcs).append(item)
    # stitch arc fragments that share a centre (some CAD exports split circles into arcs)
    used = [False] * len(arcs)
    for i, a in enumerate(arcs):
        if used[i]:
            continue
        grp = [a]
        for j in range(i + 1, len(arcs)):
            b = arcs[j]
            if not used[j] and math.dist((a["x"], a["y"]), (b["x"], b["y"])) < 0.08 * a["r"] and abs(a["r"] - b["r"]) < 0.06 * a["r"]:
                grp.append(b); used[j] = True
        if len(grp) > 1:
            pts = [p for g in grp for p in g["pts"]]
            cx, cy, r, rms = fit_circle(pts)
            if angular_coverage(pts, cx, cy) >= 330:
                circles.append(dict(x=cx, y=cy, r=r, fill=grp[0]["fill"], src="vector-arcs", coverage=360, pts=pts))
    # de-duplicate: same circle drawn twice (fill + stroke), or the inner and outer
    # edges of a thick ring drawn as a filled annulus -> keep the outer one
    out = []
    for c in sorted(circles, key=lambda c: -c["r"]):
        dup = next((o for o in out if math.dist((o["x"], o["y"]), (c["x"], c["y"])) < 0.15 * o["r"] and c["r"] / o["r"] > 0.6), None)
        if dup:
            if c["fill"] == "solid" and abs(dup["r"] - c["r"]) < 0.1 * dup["r"]:
                dup["fill"] = "solid"
            dup["ring_inner_r"] = c["r"]
            continue
        out.append(c)
    for c in out:  # a filled annulus is drawn as a ring, not a solid disc
        if c["fill"] == "solid" and c.get("ring_inner_r", 0) > 0.6 * c["r"]:
            c["fill"] = "outline"
        c.pop("ring_inner_r", None)
    for c in out:
        c.pop("pts", None)
    return out


def vector_text_in(page_chars, c):
    inside = [ch for ch in page_chars
              if math.dist(((ch["x0"] + ch["x1"]) / 2, (ch["top"] + ch["bottom"]) / 2), (c["x"], c["y"])) < 0.9 * c["r"]]
    inside.sort(key=lambda ch: (round(ch["top"] / 3), ch["x0"]))
    return "".join(ch["text"] for ch in inside).strip()

def find_callouts(chars, words=("COLUMN", "COL")):
    """Find words like COL / COLUMN in any orientation. Returns list of (x, y, size, word)."""
    letters = [c for c in chars if c["text"].strip()]
    out = []
    for c in letters:
        if c["text"].upper() != "C":
            continue
        sz = max(c.get("size", 6), 3)
        cx, cy = (c["x0"] + c["x1"]) / 2, (c["top"] + c["bottom"]) / 2
        for w in words:
            seq, last, ok = [(cx, cy)], (cx, cy), True
            for ch in w[1:]:
                nxt = [d for d in letters if d["text"].upper() == ch and 0.2 * sz < math.dist(last, ((d["x0"] + d["x1"]) / 2, (d["top"] + d["bottom"]) / 2)) < 1.3 * sz]
                if not nxt:
                    ok = False; break
                d = min(nxt, key=lambda d: math.dist(last, ((d["x0"] + d["x1"]) / 2, (d["top"] + d["bottom"]) / 2)))
                last = ((d["x0"] + d["x1"]) / 2, (d["top"] + d["bottom"]) / 2); seq.append(last)
            if ok:
                out.append((float(np.mean([p[0] for p in seq])), float(np.mean([p[1] for p in seq])), sz, w))
                break
    return out


def link_callouts(R, circles, callouts):
    """Mark circles that a COL callout points at (leader line from circle toward the text)."""
    for (tx, ty, sz, w) in callouts:
        best = None
        for c in circles:
            if c.get("label"):
                continue
            d = math.dist((c["x"], c["y"]), (tx, ty))
            if d > max(25 * c["r"], 12 * sz) or d < c["r"]:
                continue
            # leader: ink along the segment from the circle edge toward the text
            ux, uy = (tx - c["x"]) / d, (ty - c["y"]) / d
            n, hits = 30, 0
            span = d - c["r"] - 2.5 * sz  # stop short of the text itself
            if span <= 2:
                continue
            for i in range(n):
                t = c["r"] * 0.5 + span * i / n
                if R.ink_at(R.px(c["x"] + ux * t), R.px(c["y"] + uy * t), 1):
                    hits += 1
            if hits / n >= 0.8 and (best is None or d < best[0]):
                best = (d, c)
        if best:
            best[1]["callout"] = w


# ----------------------------------------------------------------- raster pass

class Raster:
    """The page rendered in a grid-aligned FRAME.

    angle: degrees the wing's grid is rotated counter-clockwise on the sheet. The render
    is rotated back by that much (canvas enlarged to fit), so the wing's grid lines are
    horizontal / vertical. All coordinates downstream are frame points (pt): to_frame()
    and from_frame() convert to and from sheet points. poly: optional sheet-point polygon;
    everything outside it is blanked so other drawings on the sheet are ignored.
    """
    def __init__(self, page, dpi, angle=0.0, poly=None):
        self.zoom = z = dpi / 72.0
        self.angle = angle
        gray = np.array(page.to_image(resolution=dpi).original.convert("L"))
        h0, w0 = gray.shape
        if poly is not None:
            m = np.zeros_like(gray)
            cv2.fillPoly(m, [np.round(np.array(poly) * z).astype(np.int32)], 255)
            gray[m == 0] = 255
        M = cv2.getRotationMatrix2D((w0 / 2, h0 / 2), -angle, 1.0)
        if abs(angle) > 1e-6:
            c, s = abs(M[0, 0]), abs(M[0, 1])
            w1, h1 = int(h0 * s + w0 * c) + 2, int(h0 * c + w0 * s) + 2
            M[0, 2] += w1 / 2 - w0 / 2; M[1, 2] += h1 / 2 - h0 / 2
            gray = cv2.warpAffine(gray, M, (w1, h1), flags=cv2.INTER_LINEAR, borderValue=255)
        self.M = M
        self.Mi = cv2.invertAffineTransform(M)
        self.gray = gray
        blur = cv2.GaussianBlur(self.gray, (3, 3), 0)
        _, self.ink = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        self.h, self.w = self.ink.shape
        self.ink_d = cv2.dilate(self.ink, np.ones((3, 3), np.uint8)) > 0  # 1px tolerance

    def to_frame(self, x, y):
        """sheet pt -> frame pt"""
        p = self.M @ np.array([x * self.zoom, y * self.zoom, 1.0])
        return float(p[0] / self.zoom), float(p[1] / self.zoom)

    def from_frame(self, x, y):
        """frame pt -> sheet pt"""
        p = self.Mi @ np.array([x * self.zoom, y * self.zoom, 1.0])
        return float(p[0] / self.zoom), float(p[1] / self.zoom)

    def px(self, v):
        return v * self.zoom

    def ink_at(self, x, y, rad=1):
        xi, yi = int(round(x)), int(round(y))
        if xi < rad or yi < rad or xi >= self.w - rad or yi >= self.h - rad:
            return False
        return self.ink[yi - rad:yi + rad + 1, xi - rad:xi + rad + 1].any()

    _ang = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    _cos, _sin = np.cos(_ang), np.sin(_ang)

    def ring_score(self, cx, cy, r):
        """Fraction of the circumference that has ink (vectorised)."""
        xs = np.rint(cx + r * self._cos).astype(int); ys = np.rint(cy + r * self._sin).astype(int)
        ok = (xs >= 0) & (ys >= 0) & (xs < self.w) & (ys < self.h)
        if not ok.all():
            return 0.0
        return float(self.ink_d[ys, xs].mean())

    def ring_scores(self, cx, cy, rs, offs=(-1, 0, 1)):
        """Best ring score over a small grid of radii / centre shifts."""
        best = (0.0, rs[0], cx, cy)
        for dx in offs:
            for dy in offs:
                X = np.rint(cx + dx + np.outer(rs, self._cos)).astype(int)
                Y = np.rint(cy + dy + np.outer(rs, self._sin)).astype(int)
                if X.min() < 0 or Y.min() < 0 or X.max() >= self.w or Y.max() >= self.h:
                    continue
                sc = self.ink_d[Y, X].mean(1)
                i = int(sc.argmax())
                if sc[i] > best[0]:
                    best = (float(sc[i]), float(rs[i]), cx + dx, cy + dy)
        return best

    def interior(self, cx, cy, r):
        """Ink fraction inside 0.7r, and whether it looks like hatching."""
        x0, x1 = int(max(cx - r, 0)), int(min(cx + r + 1, self.w))
        y0, y1 = int(max(cy - r, 0)), int(min(cy + r + 1, self.h))
        sub = self.ink[y0:y1, x0:x1]
        yy, xx = np.mgrid[y0:y1, x0:x1]
        m = (xx - cx) ** 2 + (yy - cy) ** 2 < (0.7 * r) ** 2
        if not m.any():
            return 0.0
        return float((sub[m] > 0).mean())


def raster_circles(R, min_d, max_d):
    minr, maxr = max(3, int(R.px(min_d / 2))), int(R.px(max_d / 2)) + 1
    cands = []
    # 1) Hough on the edge image (finds outlines even when lines cross them)
    g = cv2.medianBlur(R.gray, 3)
    found = cv2.HoughCircles(g, cv2.HOUGH_GRADIENT_ALT, dp=1.5, minDist=max(4, minr),
                             param1=200, param2=0.75, minRadius=minr, maxRadius=maxr)
    if found is not None:
        cands += [tuple(map(float, c)) for c in found[0]]
    # 2) round blobs (solid / hatched discs) after stripping long straight lines
    ink = R.ink.copy()
    L = max(15, int(R.px(max_d) * 1.3))
    for k in (cv2.getStructuringElement(cv2.MORPH_RECT, (L, 1)), cv2.getStructuringElement(cv2.MORPH_RECT, (1, L))):
        ink = cv2.subtract(ink, cv2.morphologyEx(R.ink, cv2.MORPH_OPEN, k))
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(ink, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    for cn in cnts:
        if len(cn) < 12:
            continue
        (x, y), r = cv2.minEnclosingCircle(cn)
        if not (minr <= r <= maxr):
            continue
        area, per = cv2.contourArea(cn), cv2.arcLength(cn, True)
        if per and 4 * math.pi * area / per ** 2 > 0.75 and area / (math.pi * r * r) > 0.7:
            cands.append((x, y, r))
    # verify + refine each candidate against the actual ink
    out = []
    for (x, y, r) in cands:
        s, rr, bx, by = R.ring_scores(x, y, np.linspace(r * 0.85, r * 1.15, 13))
        if s < 0.88:
            continue
        # a ring has *no* ink just outside it (unless something touches it); reject blobs of text/hatch
        outside = R.ring_score(bx, by, rr + max(2, rr * 0.25))
        if outside > 0.6:
            continue
        # outer edge for solid discs: walk the radius out to the last ring with ink
        fill_frac = R.interior(bx, by, rr)
        out.append(dict(x=bx / R.zoom, y=by / R.zoom, r=rr / R.zoom, ring=s, fill_frac=fill_frac, src="raster"))
    # de-duplicate concentric / near-identical detections: keep the outermost ring
    out.sort(key=lambda c: -c["ring"])
    keep = []
    for c in out:
        clash = next((k for k in keep if math.dist((k["x"], k["y"]), (c["x"], c["y"])) < 0.5 * max(k["r"], c["r"])
                      and min(k["r"], c["r"]) / max(k["r"], c["r"]) > 0.6), None)
        if clash:
            if c["r"] > clash["r"] and c["ring"] > 0.9:
                clash.update(x=c["x"], y=c["y"], r=c["r"], ring=c["ring"])
            continue
        keep.append(c)
    for c in keep:
        f = R.interior(c["x"] * R.zoom, c["y"] * R.zoom, c["r"] * R.zoom)
        c["fill"] = "solid" if f > 0.75 else ("hatched" if f > 0.25 else "outline")
        c.pop("fill_frac", None)
    return keep


def ocr_label(R, c):
    """OCR the inside of a circle; returns short alphanumeric label or ''."""
    try:
        import pytesseract
    except ImportError:
        return ""
    cx, cy, r = R.px(c["x"]), R.px(c["y"]), R.px(c["r"]) * 0.78
    x0, y0 = int(max(cx - r, 0)), int(max(cy - r, 0))
    crop = R.gray[y0:int(cy + r), x0:int(cx + r)].copy()
    if crop.size == 0:
        return ""
    yy, xx = np.mgrid[0:crop.shape[0], 0:crop.shape[1]]
    crop[(xx + x0 - cx) ** 2 + (yy + y0 - cy) ** 2 > r * r] = 255
    if (crop < 128).mean() < 0.02 or (crop < 128).mean() > 0.6:
        return ""
    big = cv2.resize(crop, None, fx=max(1, 60 / max(crop.shape)), fy=max(1, 60 / max(crop.shape)), interpolation=cv2.INTER_CUBIC)
    big = cv2.copyMakeBorder(big, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)
    for psm in (7, 10):
        t = pytesseract.image_to_string(big, config=f"--psm {psm} -c tessedit_char_whitelist=ABCDEFGHJKLMNPQRSTUVWXYZ0123456789.").strip()
        if re.fullmatch(r"[A-Z0-9][A-Z0-9.]{0,3}", t):
            return t
    return ""

# ----------------------------------------------------------------- grid

def ray_ink(R, cx, cy, r, dx, dy, length):
    """Fraction of a ray (starting just outside the circle) that has ink."""
    n = max(10, int(length / 1.5))
    hits = 0
    for i in range(n):
        d = r + 2 + length * i / n
        if R.ink_at(cx + dx * d, cy + dy * d, 1):
            hits += 1
    return hits / n


def find_grid(R, labelled):
    lines = []
    for c in labelled:
        cx, cy, r = R.px(c["x"]), R.px(c["y"]), R.px(c["r"])
        L = r * 10
        scores = {d: ray_ink(R, cx, cy, r, *d, L) for d in [(0, 1), (0, -1), (1, 0), (-1, 0)]}
        d, s = max(scores.items(), key=lambda kv: kv[1])
        if s < 0.45:
            continue
        axis = "x" if d[0] == 0 else "y"   # ray going up/down => vertical line at x
        pos = c["x"] if axis == "x" else c["y"]
        lines.append(dict(label=c["label"], axis=axis, pos=pos, bubble=(c["x"], c["y"]), r=c["r"], c=c))
    # Real grid bubbles line up with their siblings (top/bottom rows for vertical lines,
    # side columns for horizontal ones) and share a size; tags and markers inside the plan
    # that happen to touch a line do not.
    if lines:
        rmed = float(np.median([g["r"] for g in lines]))
        lines = [g for g in lines if abs(g["r"] - rmed) <= 0.2 * rmed]
    keep = []
    for g in lines:
        sib = [o for o in lines if o is not g and o["axis"] == g["axis"]]
        other = 1 if g["axis"] == "x" else 0          # the coordinate siblings share
        if not sib or any(abs(o["bubble"][other] - g["bubble"][other]) <= 2 * g["r"] for o in sib):
            keep.append(g)
    lines = keep
    for g in lines:
        g.pop("c")["role"] = "grid bubble"
        g.pop("r")
    # merge same label/axis (bubbles at both ends)
    merged = {}
    for g in lines:
        k = (g["label"], g["axis"])
        if k in merged:
            merged[k]["pos"] = (merged[k]["pos"] + g["pos"]) / 2
        else:
            merged[k] = dict(g)
    return sorted(merged.values(), key=lambda g: (g["axis"], g["pos"]))

# ----------------------------------------------------------------- scale

IMP = re.compile(r"(\d+\s*-?\s*\d+/\d+|\d+/\d+|\d+(?:\.\d+)?)\s*(?:\"|”|''|IN\.?)\s*=\s*(\d+)\s*(?:'|’|FT\.?)\s*(?:-?\s*0\s*(?:\"|”)?)?", re.I)
MET = re.compile(r"\b1\s*:\s*(\d{1,4})\b")


def parse_frac(s):
    s = s.replace(" ", "").replace("-", " ").strip()
    tot = 0.0
    for part in s.split():
        if "/" in part:
            a, b = part.split("/"); tot += float(a) / float(b)
        else:
            tot += float(part)
    return tot


def parse_scale_arg(s):
    """Return real metres per PDF point."""
    s = s.strip().lower().replace(" ", "")
    m = re.fullmatch(r"1:(\d+(?:\.\d+)?)", s)
    if m:
        return 0.0254 / 72 * float(m.group(1))
    m = re.fullmatch(r"([\d/.\-]+)(?:in|\")=(\d+)(?:ft|')(?:-?0\"?)?", s)
    if m:
        inches = parse_frac(m.group(1).replace("-", " "))
        return 0.3048 * float(m.group(2)) / (inches * 72)
    raise SystemExit(f"Could not read --scale '{s}'. Use e.g. '1/8in=1ft' or '1:100'.")


def detect_scales(text):
    found = []
    for m in IMP.finditer(text):
        try:
            v, ft = parse_frac(m.group(1)), float(m.group(2))
            if v > 3 and re.search(r"[\s-]", m.group(1).strip()):
                frac = re.split(r"[\s-]+", m.group(1).strip())[-1]   # "...10 3/32\"" is a sheet number + 3/32"
                v = parse_frac(frac)
                found.append((f'{frac}" = {int(ft)}\'-0"', 0.3048 * ft / (v * 72), "imperial")) if 0 < v <= 3 else None
                continue
            if 0 < v <= 3 and ft >= 1:
                found.append((m.group(0).strip(), 0.3048 * ft / (v * 72), "imperial"))
        except Exception:
            pass
    for m in MET.finditer(text):
        n = int(m.group(1))
        if 5 <= n <= 2000:
            found.append((m.group(0), 0.0254 / 72 * n, "metric"))
    return found

# ----------------------------------------------------------------- classification

def classify(circles, grid, column_dia=None, tol=0.08):
    gx = [g for g in grid if g["axis"] == "x"]
    gy = [g for g in grid if g["axis"] == "y"]
    plain = [c for c in circles if not c.get("label")]

    def near(c, tol):
        lx = min(gx, key=lambda g: abs(g["pos"] - c["x"]), default=None)
        ly = min(gy, key=lambda g: abs(g["pos"] - c["y"]), default=None)
        on_x = lx is not None and abs(lx["pos"] - c["x"]) <= tol
        on_y = ly is not None and abs(ly["pos"] - c["y"]) <= tol
        return on_x, on_y

    if column_dia:
        sizes = [column_dia]
    else:
        anchors = [c for c in plain if c.get("callout")]
        anchors += [c for c in plain if all(near(c, max(c["r"] * 0.6, 1.5)))] if gx and gy else []
        if anchors:
            ds = sorted(2 * c["r"] for c in anchors)
        else:  # no grid: use repeated sizes
            ds = sorted(2 * c["r"] for c in plain)
        sizes = []
        for d in ds:  # cluster diameters within 8%
            if not sizes or d > sizes[-1][-1] * (1 + tol):
                sizes.append([d])
            else:
                sizes[-1].append(d)
        min_count = 1 if anchors else 3
        sizes = [float(np.median(s)) for s in sizes if len(s) >= min_count]

    for c in circles:
        if c.get("label"):
            c.setdefault("role", "labelled tag (not a column)")
            continue
        d = 2 * c["r"]
        size_ok = any(abs(d - s) <= tol * s + (0.2 if tol < 0.05 else 0.6) for s in sizes)
        on_x, on_y = near(c, max(c["r"] * 0.6, 1.5)) if grid else (False, False)
        if c.get("callout"):
            c["role"], c["confidence"] = "column", "High"
            c["note"] = f"Tagged '{c['callout']}' on the drawing"
        elif size_ok and on_x and on_y:
            c["role"], c["confidence"] = "column", "High"
            c["note"] = "On grid intersection"
        elif size_ok and (on_x or on_y):
            c["role"], c["confidence"] = "column", "High" if c["fill"] != "outline" else "Medium"
            c["note"] = "On one grid line, offset from intersection"
        elif size_ok and not grid:
            c["role"], c["confidence"] = "column", "Medium"
            c["note"] = "Repeated column-size circle (no grid found)"
        elif size_ok:
            c["role"], c["confidence"] = "column", "Medium" if c["fill"] != "outline" else "Low"
            c["note"] = "Column size but off grid - check"
        else:
            c["role"] = "other circle"
            c["note"] = "Different size from the columns on this plan"
    return sizes

# ----------------------------------------------------------------- grid reference

def grid_ref(c, grid, m_per_pt, units):
    """Describe a column's position against the grid.

    A column within a short distance of a grid line is 'on' that line (columns often
    sit a few inches off the line, at a wall face); otherwise it is 'between' two
    lines and its offset is measured from the line to its left / above.
    """
    gx = sorted([g for g in grid if g["axis"] == "x"], key=lambda g: g["pos"])
    gy = sorted([g for g in grid if g["axis"] == "y"], key=lambda g: g["pos"])
    conv = lambda v: fmt_len(v * m_per_pt, units) if m_per_pt else f"{v:.1f} pt"
    exact = max(c["r"] * 0.6, 1.5)

    def describe(lines, v, pos_word, neg_word):
        if not lines:
            return "", "", ""
        spacing = min([b["pos"] - a["pos"] for a, b in zip(lines, lines[1:])] or [1e9])
        snap = min(0.6096 / m_per_pt if m_per_pt else 6 * c["r"], 0.15 * spacing)  # 2 ft, or 15% of a bay
        near = min(lines, key=lambda g: abs(g["pos"] - v))
        d = v - near["pos"]
        if abs(d) <= snap:
            off = f"on {near['label']}" if abs(d) <= exact else f"{conv(abs(d))} {pos_word if d > 0 else neg_word} {near['label']}"
            return near["label"], near["label"], off
        for a_, b_ in zip(lines, lines[1:]):
            if a_["pos"] < v < b_["pos"]:
                return f"{a_['label']}/{b_['label']}", near["label"], f"{conv(v - a_['pos'])} {pos_word} {a_['label']}"
        return f"outside {near['label']}", near["label"], f"{conv(abs(d))} {pos_word if d > 0 else neg_word} {near['label']}"

    lx, nx, ox = describe(gx, c["x"], "right of", "left of")
    ly, ny, oy = describe(gy, c["y"], "below", "above")
    return dict(grid="-".join(p for p in (lx, ly) if p), near="-".join(p for p in (nx, ny) if p), dx=ox, dy=oy)


def fmt_len(m, units):
    if units == "m":
        return f"{m * 1000:.0f} mm"
    inches = m / 0.0254
    sign = "-" if inches < 0 else ""
    inches = abs(inches)
    ft, ins = int(inches // 12), inches - 12 * int(inches // 12)
    if round(ins) == 12:
        ft, ins = ft + 1, 0
    return f"{sign}{ft}'-{ins:.0f}\"" if ft else f"{sign}{ins:.1f}\""

# ----------------------------------------------------------------- outputs

def draw_overlay(R, circles, grid, out):
    img = cv2.cvtColor(R.gray, cv2.COLOR_GRAY2BGR)
    img = (img * 0.55 + 255 * 0.45).astype(np.uint8)  # fade drawing so marks stand out
    z = R.zoom
    for g in grid:
        p = int(g["pos"] * z)
        if g["axis"] == "x":
            cv2.line(img, (p, 0), (p, R.h), (230, 160, 40), max(1, int(z / 2)))
        else:
            cv2.line(img, (0, p), (R.w, p), (230, 160, 40), max(1, int(z / 2)))
    fs = max(0.5, z * 0.35)
    for c in circles:
        x, y, r = int(c["x"] * z), int(c["y"] * z), int(c["r"] * z)
        if c.get("proposed"):
            col = (200, 90, 0) if "in wall" in c["status"] else (0, 0, 230)
            s_ = max(r, int(5 * z))
            cv2.rectangle(img, (x - s_, y - s_), (x + s_, y + s_), col, max(2, int(z)))
            cv2.putText(img, f"P{c['id']}", (x + s_ + 2, y - s_), cv2.FONT_HERSHEY_SIMPLEX, fs, col, max(1, int(z / 1.5)), cv2.LINE_AA)
        elif c.get("role") == "column":
            col = {"High": (40, 170, 40), "Medium": (0, 165, 255), "Low": (0, 0, 230)}[c["confidence"]]
            cv2.circle(img, (x, y), r + int(4 * z), col, max(2, int(z)))
            cv2.putText(img, str(c["id"]), (x + r + int(4 * z), y - r), cv2.FONT_HERSHEY_SIMPLEX, fs, col, max(1, int(z / 1.5)), cv2.LINE_AA)
        elif c.get("role") == "grid bubble":
            cv2.circle(img, (x, y), r + int(2 * z), (230, 160, 40), max(1, int(z / 2)))
        else:
            cv2.circle(img, (x, y), r + int(2 * z), (160, 60, 200), 1)
            cv2.putText(img, f"x{c['id']}", (x + r + 2, y + r), cv2.FONT_HERSHEY_SIMPLEX, fs * 0.7, (160, 60, 200), 1, cv2.LINE_AA)
    # overview, max 2400 px wide
    s = min(1.0, 2400 / R.w)
    cv2.imwrite(os.path.join(out, "overlay.png"), cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA))
    # tiles over the area that has findings
    pts = [(c["x"] * z, c["y"] * z) for c in circles] or [(0, 0), (R.w, R.h)]
    x0, y0 = max(0, int(min(p[0] for p in pts) - 80 * z)), max(0, int(min(p[1] for p in pts) - 80 * z))
    x1, y1 = min(R.w, int(max(p[0] for p in pts) + 80 * z)), min(R.h, int(max(p[1] for p in pts) + 80 * z))
    tile = 1400
    nx, ny = max(1, math.ceil((x1 - x0) / tile)), max(1, math.ceil((y1 - y0) / tile))
    tiles = []
    for j in range(ny):
        for i in range(nx):
            a, b = x0 + i * (x1 - x0) // nx, y0 + j * (y1 - y0) // ny
            crop = img[b:b + (y1 - y0) // ny + 40, a:a + (x1 - x0) // nx + 40]
            fn = os.path.join(out, f"overlay_tile_r{j + 1}c{i + 1}.png")
            cv2.imwrite(fn, crop); tiles.append(os.path.basename(fn))
    return tiles


def summary_rows(circles, grid, m_per_pt, units):
    rows = []
    for c in circles:
        if c.get("role") != "column":
            continue
        ref = grid_ref(c, grid, m_per_pt, units)
        rows.append({"Column ID": c["id"], "Grid location": ref["grid"], "Horizontal position": ref["dx"],
                     "Vertical position": ref["dy"], "Status": c.get("status", ""), "Notes": c.get("note", "")})
    return rows


# ----------------------------------------------------------------- rotation helpers

def estimate_angle(page, inside):
    """Dominant line direction of the drawing (vector lines), as the grid's counter-clockwise
    rotation in degrees, in (-45, 45]. Walls and grid lines dominate, so the peak is the grid."""
    hist = np.zeros(360)
    for ln in page.lines:
        (x0, y0), (x1, y1) = ln["pts"][0], ln["pts"][-1]
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 20 or not inside((x0 + x1) / 2, (y0 + y1) / 2):
            continue
        a = math.degrees(math.atan2(y1 - y0, x1 - x0)) % 90
        hist[int(a * 4) % 360] += L
    if not hist.any():
        return 0.0
    sm = hist + np.roll(hist, 1) + np.roll(hist, -1)
    i = int(sm.argmax())
    w = hist[[i - 1, i, (i + 1) % 360]]
    a = (i + (w[2] - w[0]) / max(w.sum(), 1e-9)) / 4 + 0.125
    th = (-a) % 90
    if th > 45:
        th -= 90
    return 0.0 if abs(th) < 0.3 else round(th, 2)


def frame_strings(chars):
    """Rebuild text runs from character positions in the frame, both along rows and
    along columns (vertical dimension text), in both reading directions."""
    pts = [(ch["x0"], ch["top"], max(float(ch.get("size") or 6), 2.0), ch["text"]) for ch in chars if ch["text"].strip()]
    out = []
    for a, b in ((1, 0), (0, 1)):          # group by y then read along x; group by x then read along y
        groups = []
        for p in sorted(pts, key=lambda p: p[a]):
            if groups and abs(p[a] - groups[-1][-1][a]) <= 0.35 * p[2]:
                groups[-1].append(p)
            else:
                groups.append([p])
        for g in groups:
            g.sort(key=lambda p: p[b])
            s, last = "", None
            for p in g:
                if last is not None:
                    gap = p[b] - last
                    if gap > 1.8 * p[2]:
                        out += [s, s[::-1]]; s = ""
                    elif gap > 0.85 * p[2]:
                        s += " "                      # word gap, e.g. 16'-6 3/4"
                s += p[3]; last = p[b]
            out += [s, s[::-1]]
    return [t for t in out if len(t) >= 3]


# ----------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf"); ap.add_argument("--out", default="column_results")
    ap.add_argument("--page", type=int, default=1)
    ap.add_argument("--mode", choices=["auto", "vector", "raster"], default="auto")
    ap.add_argument("--scale", help="e.g. '1/8in=1ft' or '1:100' (overrides scale read from the sheet)")
    ap.add_argument("--units", choices=["ft", "m"], help="report real sizes in ft-in or mm (default: from scale)")
    ap.add_argument("--min-dia", type=float, default=3.0, help="smallest circle to consider, PDF points")
    ap.add_argument("--max-dia", type=float, default=72.0, help="largest circle to consider, PDF points")
    ap.add_argument("--column-dia", type=float, action="append", help="force column diameter(s), PDF points as drawn")
    ap.add_argument("--region", help="only look inside x0,y0,x1,y1 (PDF points from top-left), e.g. one drawing on a multi-drawing sheet")
    ap.add_argument("--region-poly", help="drawing area as a polygon 'x,y x,y x,y ...' in PDF points (e.g. one wing of a building)")
    ap.add_argument("--rotate", help="degrees the grid is rotated counter-clockwise on the sheet, or 'auto' to measure it")
    ap.add_argument("--wing", default="", help="name for this part of the building (e.g. 'West wing') when a plan has several grids")
    ap.add_argument("--dpi", type=int, default=0, help="render resolution (default: auto)")
    ap.add_argument("--include", nargs="*", default=[], help="'Other circle' refs (e.g. x12) to force as columns")
    ap.add_argument("--exclude", nargs="*", default=[], help="column IDs to drop")
    ap.add_argument("--ignore-existing", action="store_true", help="leave drawn columns out of the model (test a fresh layout)")
    ap.add_argument("--max-spacing", type=float, default=40, help="max distance between columns along a grid line, ft")
    ap.add_argument("--max-shift", type=float, default=3, help="how far a column may move off its grid point to get into a wall, ft")
    ap.add_argument("--clearance", type=float, default=6, help="clearance from door/window opening edges, inches")
    ap.add_argument("--assumed-col", type=float, default=6, help="column diameter, inches (clearance checks and DXF symbol)")
    ap.add_argument("--keepout", action="append", default=[], help="x0,y0,x1,y1 in PDF points: an opening (storefront, window, door) columns must stay clear of; repeatable")
    ap.add_argument("--height", type=float, default=14, help="column height for the 3D DXF layer, ft (1-story default)")
    ap.add_argument("--wall-max", type=float, default=18, help="thickest wall to recognise, inches")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    pdf = pdfplumber.open(a.pdf)
    page = pdf.pages[a.page - 1]
    W, H = float(page.width), float(page.height)
    n_vec = len(page.curves) + len(page.lines) + len(page.rects)
    img_area = sum((i["x1"] - i["x0"]) * (i["bottom"] - i["top"]) for i in page.images)
    is_scan = img_area > 0.5 * W * H and n_vec < 200
    mode = a.mode if a.mode != "auto" else ("raster" if is_scan else "vector")

    # drawing area: --region (box) or --region-poly (any polygon), in sheet points
    region = [float(v) for v in a.region.split(",")] if a.region else None
    poly = None
    if a.region_poly:
        poly = [tuple(float(v) for v in p.split(",")) for p in a.region_poly.split()]
    elif region:
        poly = [(region[0], region[1]), (region[2], region[1]), (region[2], region[3]), (region[0], region[3])]
    in_sheet_poly = (lambda x, y: True) if poly is None else (lambda x, y: cv2.pointPolygonTest(np.float32(poly), (float(x), float(y)), False) >= 0)

    # grid rotation: degrees the wing's grid is turned counter-clockwise on the sheet
    angle = 0.0
    if a.rotate == "auto":
        angle = estimate_angle(page, in_sheet_poly)
        print(f"Grid rotation (auto): {angle:.2f} deg")
    elif a.rotate:
        angle = float(a.rotate)

    dpi = a.dpi or int(max(100, min(300, 9000 / (max(W, H) / 72))))
    R = Raster(page, dpi, angle, poly)
    fpoly = [R.to_frame(*p) for p in poly] if poly else None
    fregion = [min(p[0] for p in fpoly), min(p[1] for p in fpoly), max(p[0] for p in fpoly), max(p[1] for p in fpoly)] if fpoly else None
    in_region = (lambda x, y: True) if fpoly is None else (lambda x, y: cv2.pointPolygonTest(np.float32(fpoly), (float(x), float(y)), False) >= 0)

    def fchar(ch):
        fx, fy = R.to_frame((ch["x0"] + ch["x1"]) / 2, (ch["top"] + ch["bottom"]) / 2)
        return {**ch, "x0": fx, "x1": fx, "top": fy, "bottom": fy}

    chars, fstrings = [], []
    if mode == "vector":
        circles = vector_circles(page, a.min_dia, a.max_dia)
        for c in circles:
            c["x"], c["y"] = R.to_frame(c["x"], c["y"])
        chars = [fchar(ch) for ch in page.chars if in_sheet_poly((ch["x0"] + ch["x1"]) / 2, (ch["top"] + ch["bottom"]) / 2)]
        for c in circles:
            c["label"] = vector_text_in(chars, c)
        # hatched outlines: look at interior ink in the render
        for c in circles:
            if c["fill"] == "outline" and not c["label"] and R.interior(R.px(c["x"]), R.px(c["y"]), R.px(c["r"])) > 0.25:
                c["fill"] = "hatched"
        if region:
            text = page.within_bbox((max(0, region[0]), max(0, region[1]), min(W, region[2]), min(H, region[3]))).extract_text() or ""
        else:
            text = page.extract_text() or ""
        fstrings = frame_strings(chars)
    else:
        circles = raster_circles(R, a.min_dia, a.max_dia)
        for c in circles:
            c["label"] = ocr_label(R, c) if c["fill"] != "solid" else ""
        text = ""
        try:
            import pytesseract
            small = cv2.resize(R.gray, None, fx=min(1, 5000 / R.w), fy=min(1, 5000 / R.w))
            text = pytesseract.image_to_string(small, config="--psm 11")
        except Exception:
            pass
    circles = [c for c in circles if in_region(c["x"], c["y"])]
    if mode == "vector":
        link_callouts(R, circles, find_callouts(chars))

    labelled = [c for c in circles if c.get("label") and len(c["label"]) <= 4]
    for c in circles:
        if c.get("label") and len(c["label"]) > 4:
            c["role"] = "labelled tag (not a column)"
    grid = find_grid(R, labelled)

    # scale
    scales = detect_scales(text)
    m_per_pt, scale_text = None, None
    if a.scale:
        m_per_pt, scale_text = parse_scale_arg(a.scale), a.scale + " (given)"
    else:
        uniq = {round(s[1], 9): s for s in scales}
        if len(uniq) == 1:
            s = next(iter(uniq.values())); m_per_pt, scale_text = s[1], f"{s[0]} (read from sheet)"
        elif not uniq and region and mode == "vector":
            # the drawing title (and its scale) often sits outside one wing's area
            allsc = {round(s[1], 9): s for s in detect_scales(page.extract_text() or "")}
            if len(allsc) == 1:
                s = next(iter(allsc.values())); m_per_pt, scale_text = s[1], f"{s[0]} (read from the sheet's drawing title)"
    units = a.units or ("m" if (scale_text and ":" in scale_text) else "ft")

    sizes = classify(circles, grid, a.column_dia, tol=0.03 if mode == "vector" else 0.08)
    circles.sort(key=lambda c: (round(c["y"] / 20), c["x"]))
    n = o = 0
    for c in circles:
        if c.get("role") == "column":
            n += 1; c["id"] = n
        else:
            o += 1; c["id"] = o
    # manual overrides
    for ref in a.include:
        k = int(ref.lstrip("xX"))
        for c in circles:
            if c.get("role") != "column" and c["id"] == k:
                c.update(role="column", confidence="High", note="Confirmed by reviewer")
    drop = {int(e) for e in a.exclude}
    for c in circles:
        if c.get("role") == "column" and c["id"] in drop:
            c.update(role="other circle", note="Removed by reviewer")
    if a.include or a.exclude:  # renumber
        n = o = 0
        for c in circles:
            if c.get("role") == "column":
                n += 1; c["id"] = n
            else:
                o += 1; c["id"] = o

    # Low-confidence finds (off grid, no callout, matched only by size) are usually
    # fixtures - sink drains, floor drains, bollards - so they are reported for review
    # but kept out of the model unless confirmed with --include.
    for c in circles:
        if c.get("role") == "column" and c.get("confidence") == "Low":
            c.update(role="possible column", note="Low confidence - not used; confirm with --include x<ref> if it is a column")

    # Steel W-shape (I / H) column symbols drawn as outlines - unambiguous, so taken as drawn
    # columns. Only those square to THIS wing's grid count (another wing's are skipped).
    if mode == "vector" and m_per_pt:
        import wshape
        k_in = m_per_pt / 0.0254
        for w in wshape.find_wshapes(page, k_in, in_sheet_poly):
            rel = (w["web_angle_deg"] + angle) % 90          # web direction in the frame (sheet angles are clockwise)
            if min(rel, 90 - rel) > 4:
                continue
            fx, fy = R.to_frame(w["x"], w["y"])
            if not in_region(fx, fy):
                continue
            near_line = any(abs((fx if g["axis"] == "x" else fy) - g["pos"]) * k_in <= 24 for g in grid)
            web_vertical = abs(((w["web_angle_deg"] + angle) % 180) - 90) < 10
            n_w = sum(1 for c in circles if c.get("shape"))
            circles.append(dict(x=fx, y=fy, r=w["depth_in"] / k_in / 2, fill="W-shape", label="", src="vector-W",
                                role="column", confidence="High" if near_line else "Medium", id=1000 + n_w,
                                shape=dict(type="W", depthIn=w["depth_in"], flangeIn=w["flange_in"], orient="I" if web_vertical else "H"),
                                note=f"Steel W-shape symbol on the drawing (about {w['depth_in']:.0f}\" deep x {w['flange_in']:.0f}\" flange)"))
        n_w = sum(1 for c in circles if c.get("shape"))
        if n_w:
            print(f"W-shape column symbols: {n_w} found in this area")
            nn = 0
            for c in sorted([c for c in circles if c.get("role") == "column"], key=lambda c: (round(c["y"] / 20), c["x"])):
                nn += 1; c["id"] = nn
    existing = [c for c in circles if c.get("role") == "column"]
    for c in existing:
        c["status"] = f"Existing ({c['confidence']} confidence)"
    if a.ignore_existing:
        existing = []
    M = None
    if m_per_pt and grid:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import layout as LY
        M = LY.wall_masks(R, m_per_pt, fregion, t_max=a.wall_max * LY.IN, clearance=0, col_r=0,
                          keepouts=[tuple(float(v) for v in k.split(",")) for k in a.keepout])
        LY.wall_debug_image(R, M, os.path.join(a.out, "walls_check.png"))
    proposed = []

    meta = dict(file=os.path.basename(a.pdf), page=a.page, region=region, pages_in_pdf=len(pdf.pages), mode=mode, dpi=dpi,
                sheet_size_in=[round(W / 72, 2), round(H / 72, 2)], scale_text=scale_text,
                scales_seen_on_sheet=[s[0] for s in scales], metres_per_pt=m_per_pt,
                column_sizes_pt=[round(s, 2) for s in sizes])
    rows = summary_rows(circles, grid, m_per_pt, units)
    model_path = None
    if m_per_pt and grid:
        import model_export
        # dimension text: the page's own words (upright and vertical) plus text rebuilt in the
        # grid frame (needed when the grid is rotated)
        dim_page = None
        if mode == "vector":
            dim_page = page.within_bbox((max(0, region[0]), max(0, region[1]), min(W, region[2]), min(H, region[3]))) if region else page
        model_path = model_export.export(a.out, meta, grid, existing, M, R, m_per_pt, text, fregion, a,
                                         R.w / R.zoom, R.h / R.zoom, page=dim_page, texts=fstrings)
    tiles = draw_overlay(R, circles, grid, a.out)
    json.dump(dict(meta=meta, grid=grid, circles=[{k: (round(v, 2) if isinstance(v, float) else v) for k, v in c.items()} for c in circles],
                   tiles=tiles), open(os.path.join(a.out, "columns.json"), "w"), indent=1)

    conf = Counter(r["Status"] for r in rows)
    wall_img = None
    print(f"Mode: {mode} ({dpi} dpi render) | sheet {W/72:.1f} x {H/72:.1f} in | page {a.page}/{len(pdf.pages)}")
    print(f"Scale: {scale_text or 'not determined'}" + (f" | also seen: {meta['scales_seen_on_sheet']}" if len(scales) > 1 else ""))
    print(f"Grid lines: {', '.join(g['label'] + ('|' if g['axis']=='x' else '-') for g in grid) or 'none'}")
    print(f"Circles found: {len(circles) - len(proposed)} | columns: {len(rows)} -> " + ", ".join(f"{k}: {v}" for k, v in sorted(conf.items())))
    print(f"Outputs in {a.out}: columns.json, overlay.png, {len(tiles)} tile(s)" + (", walls_check.png, model.json, underlay.jpg" if model_path else ""))
    if not model_path:
        print("NO MODEL WRITTEN: " + ("scale unknown - pass --scale" if not m_per_pt else "no grid found") + ". The DXF needs both.")


if __name__ == "__main__":
    main()
