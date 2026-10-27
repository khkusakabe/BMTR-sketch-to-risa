"""Turn detection results into a building model in real inches (model.json).

Model space: inches, origin at the intersection of the left-most vertical grid
line and the bottom-most horizontal grid line, X to the right, Y up (as the
sheet is viewed). Grid spacings are snapped to dimension strings found on the
drawing when one is within tolerance; otherwise rounded to the nearest inch.
"""
import json, math, os, re
import numpy as np
import cv2

DIM = re.compile(r"(\d{1,4})\s*'\s*-?\s*(\d{1,2})(?:\s+(\d+)/(\d+))?\s*\"")


def dim_values(text, page=None, extra=()):
    """All ft-in dimension values (inches) in the drawing text, rotated text included."""
    texts = [text or ""] + list(extra or [])
    if page is not None:
        try:
            for w in page.extract_words(extra_attrs=["upright"]):
                if not w["upright"]:
                    texts.append(w["text"][::-1])  # vertical text reads reversed
        except Exception:
            pass
    vals = []
    for t in texts:
        for m in DIM.finditer(t):
            ft, inch = int(m.group(1)), int(m.group(2))
            frac = int(m.group(3)) / int(m.group(4)) if m.group(3) else 0
            v = ft * 12 + inch + frac
            if v >= 24 and inch < 12:
                vals.append(v)
    return sorted(set(vals))


def _snap(measured, dims):
    """measured: ascending model positions (in). Returns snapped positions + sources."""
    pos, src = [0.0], []
    for a, b in zip(measured, measured[1:]):
        d = b - a
        cand = [v for v in dims if abs(v - d) <= max(3.0, 0.005 * d)]
        if cand:
            v = min(cand, key=lambda v: abs(v - d)); src.append("dimension")
        else:
            v = round(d); src.append("measured")
        pos.append(pos[-1] + v)
    return pos, src


def _interp(u, meas, snap):
    """Piecewise-linear map from measured to snapped coordinates, extrapolating at the ends."""
    if len(meas) == 1:
        return u - meas[0] + snap[0]
    if u <= meas[0]:
        i = 0
    elif u >= meas[-1]:
        i = len(meas) - 2
    else:
        i = int(np.searchsorted(meas, u)) - 1
    t = (u - meas[i]) / (meas[i + 1] - meas[i])
    return snap[i] + t * (snap[i + 1] - snap[i])


def ref_line(lines, v, near=24.0):
    """Grid line a position is measured from: the nearest one if within 2 ft,
    otherwise the line to its left / below. Same rule as column_engine.js."""
    if not lines:
        return dict(label="", pos=0.0)
    n = min(lines, key=lambda g: abs(g["pos"] - v))
    if abs(n["pos"] - v) <= near:
        return n
    below = [g for g in lines if g["pos"] <= v]
    return max(below, key=lambda g: g["pos"]) if below else n


def export(out, meta, grid, existing, M, R, m_per_pt, text, region, args, W, H, page=None, texts=()):
    k = m_per_pt / 0.0254  # inches per PDF point
    gx = sorted([g for g in grid if g["axis"] == "x"], key=lambda g: g["pos"])
    gy = sorted([g for g in grid if g["axis"] == "y"], key=lambda g: -g["pos"])  # bottom first
    dims = dim_values(text, page, texts)
    x0p = gx[0]["pos"] if gx else 0.0
    y0p = gy[0]["pos"] if gy else H
    mx = [(g["pos"] - x0p) * k for g in gx]
    my = [(y0p - g["pos"]) * k for g in gy]
    sx, srcx = _snap(mx, dims) if gx else ([], [])
    sy, srcy = _snap(my, dims) if gy else ([], [])

    def to_model(xp, yp):
        X = _interp((xp - x0p) * k, mx, sx) if gx else (xp - x0p) * k
        Y = _interp((y0p - yp) * k, my, sy) if gy else (y0p - yp) * k
        return X, Y

    q = lambda v: round(v * 4) / 4  # quarter inch
    grid_out = dict(
        x=[dict(label=g["label"], pos=q(p), source=s) for g, p, s in zip(gx, sx, ["origin"] + srcx)],
        y=[dict(label=g["label"], pos=q(p), source=s) for g, p, s in zip(gy, sy, ["origin"] + srcy)])

    cols = []
    for c in existing:
        X, Y = to_model(c["x"], c["y"])
        rx, ry = ref_line(grid_out["x"], X), ref_line(grid_out["y"], Y)
        col = dict(id=f"C{len(cols) + 1}", status="existing", refX=rx["label"], dx=q(X - rx["pos"]),
                   refY=ry["label"], dy=q(Y - ry["pos"]), note=c.get("note", "Drawn on plan"))
        if c.get("shape"):
            col["shape"] = c["shape"]
        cols.append(col)

    def rects(mask, kind_fn, min_len_in=0):
        res = []
        if mask is None:
            return res
        n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        for i in range(1, n):
            x, y, w, h = st[i, :4]
            ax, ay = to_model(x / R.zoom, (y + h) / R.zoom)
            bx, by = to_model((x + w) / R.zoom, y / R.zoom)
            r = dict(x0=round(min(ax, bx), 1), y0=round(min(ay, by), 1), x1=round(max(ax, bx), 1), y1=round(max(ay, by), 1))
            if max(r["x1"] - r["x0"], r["y1"] - r["y0"]) < min_len_in:
                continue
            r.update(kind_fn(r))
            res.append(r)
        return res

    walls, openings = [], []
    if M is not None:
        walls = rects(M["wall_h"], lambda r: dict(dir="h"), 24) + rects(M["wall_v"], lambda r: dict(dir="v"), 24)
        # doors / cased openings are at least ~2'-6" wide; shorter gaps are drafting breaks
        openings = rects(M["openings"], lambda r: dict(kind="opening"), 28) + rects(M["windows"], lambda r: dict(kind="window"), 18)
    # building footprint: walls closed across door/window gaps, then filled
    footprint = []
    if M is not None:
        import layout as LY
        for poly in LY.footprint(M, R, m_per_pt):
            pts = [to_model(x, y) for (x, y) in poly]
            footprint.append([[round(a, 1), round(b, 1)] for a, b in pts])
    for kp in args.keepout:
        x0, y0, x1, y1 = [float(v) for v in kp.split(",")]
        ax, ay = to_model(x0, y1); bx, by = to_model(x1, y0)
        openings.append(dict(x0=round(ax, 1), y0=round(ay, 1), x1=round(bx, 1), y1=round(by, 1), kind="marked"))

    # underlay image of the drawing, lightened, for the app preview and the DXF check
    if region:
        rx0, ry0, rx1, ry1 = region
    else:
        allx = [g["pos"] for g in gx] or [0, W]; ally = [g["pos"] for g in gy] or [0, H]
        mxg, myg = 0.15 * (max(allx) - min(allx) + 200), 0.15 * (max(ally) - min(ally) + 200)
        rx0, rx1, ry0, ry1 = min(allx) - mxg, max(allx) + mxg, min(ally) - myg, max(ally) + myg
    rx0, ry0, rx1, ry1 = max(0, rx0), max(0, ry0), min(W, rx1), min(H, ry1)
    crop = R.gray[int(ry0 * R.zoom):int(ry1 * R.zoom), int(rx0 * R.zoom):int(rx1 * R.zoom)]
    s = min(1.0, 2000 / max(1, crop.shape[1]))
    crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(out, "underlay.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 72])
    ux0, uy1 = to_model(rx0, ry0); ux1, uy0 = to_model(rx1, ry1)

    # where this wing sits in the building: building coordinates are sheet-based inches
    # (X right, Y up as the sheet is viewed); local model (0,0) is this wing's bottom-left
    # grid intersection and its local X axis points along `angleDeg`.
    o_sheet = R.from_frame(x0p, y0p)
    e_sheet = R.from_frame(x0p + 100.0, y0p)
    ang = math.degrees(math.atan2(-(e_sheet[1] - o_sheet[1]), e_sheet[0] - o_sheet[0]))
    frame = dict(angleDeg=round(ang, 3), ox=round(o_sheet[0] * k, 2), oy=round(-o_sheet[1] * k, 2), inPerPt=k)

    model = dict(
        version=1,
        wing=getattr(args, "wing", "") or "",
        frame=frame,
        project=dict(name=os.path.splitext(meta["file"])[0], file=meta["file"], page=meta["page"],
                     scale=meta.get("scale_text"), stories=1),
        units="in",
        grid=grid_out,
        dimensions_on_sheet=[f"{int(v // 12)}'-{v % 12:g}\"" for v in dims],
        walls=walls, openings=openings, columns=cols, footprint=footprint,
        rules=dict(maxSpacingFt=args.max_spacing, maxShiftFt=args.max_shift, clearanceIn=args.clearance),
        column=dict(diaIn=args.assumed_col, heightFt=args.height),
        underlay=dict(file="underlay.jpg", x0=round(ux0, 1), y0=round(uy0, 1), x1=round(ux1, 1), y1=round(uy1, 1)),
    )
    path = os.path.join(out, "model.json")
    json.dump(model, open(path, "w"), indent=1)
    snapped = sum(1 for s_ in srcx + srcy if s_ == "dimension")
    print(f"Model: grid {[g['label'] for g in grid_out['x']]} x {[g['label'] for g in grid_out['y']]}, "
          f"{snapped}/{len(srcx) + len(srcy)} spacings matched to dimension strings, "
          f"{len(walls)} wall runs, {len(openings)} openings, {len(cols)} drawn columns")
    return path
