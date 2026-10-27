"""Read walls, openings and windows from the rendered page image.

Walls are long parallel line pairs (or solid fill) 3-18 in apart; openings are
gaps between collinear wall runs; windows are short runs with extra glazing
lines inside the wall. Works the same for vector exports and scans. The column
layout itself is done by assets/column_engine.js from these results.
"""
import math
import numpy as np
import cv2

FT = 0.3048
IN = 0.0254


def _rect(w, h):
    return cv2.getStructuringElement(cv2.MORPH_RECT, (max(1, int(w)), max(1, int(h))))


def wall_masks(R, m_per_pt, region=None, t_min=3 * IN, t_max=18 * IN, l_min=2 * FT,
               gap_max=10 * FT, clearance=6 * IN, col_r=3 * IN, keepouts=(), window_max=200 * FT):
    """Return dict of boolean masks (pixel space): wall, wall_h, wall_v, keepout, allowed."""
    ppm = R.zoom / m_per_pt  # pixels per metre
    ink = (R.ink > 0).astype(np.uint8)
    if region:
        m = np.zeros_like(ink)
        x0, y0, x1, y1 = [int(v * R.zoom) for v in region]
        m[max(0, y0):y1, max(0, x0):x1] = 1
        ink &= m
    Lmin, tmax, tmin = int(l_min * ppm), int(t_max * ppm) + 2, max(2, int(t_min * ppm))

    def bands(horizontal):
        long_k, across_k = (_rect(Lmin, 1), _rect(1, tmax)) if horizontal else (_rect(1, Lmin), _rect(tmax, 1))
        thick_k = _rect(1, tmin) if horizontal else _rect(tmin, 1)
        lines = cv2.morphologyEx(ink, cv2.MORPH_OPEN, long_k)          # long straight strokes only
        band = cv2.morphologyEx(lines, cv2.MORPH_CLOSE, across_k)        # fill between close parallel lines
        band = cv2.morphologyEx(band, cv2.MORPH_OPEN, thick_k)           # drop single lines
        band = cv2.morphologyEx(band, cv2.MORPH_OPEN, long_k)            # keep long runs only
        return band.astype(bool), lines.astype(bool)

    wall_h, lines_h = bands(True)
    wall_v, lines_v = bands(False)
    wall = wall_h | wall_v

    # openings: gaps between collinear wall runs (doors, cased openings, storefront breaks)
    gap = int(gap_max * ppm)
    clr = int((clearance + col_r) * ppm)
    open_h = cv2.morphologyEx(wall_h.astype(np.uint8), cv2.MORPH_CLOSE, _rect(gap, 1)).astype(bool) & ~wall
    open_v = cv2.morphologyEx(wall_v.astype(np.uint8), cv2.MORPH_CLOSE, _rect(1, gap)).astype(bool) & ~wall
    keep_h = cv2.dilate(open_h.astype(np.uint8), _rect(2 * clr + 1, 1)).astype(bool)
    keep_v = cv2.dilate(open_v.astype(np.uint8), _rect(1, 2 * clr + 1)).astype(bool)

    # windows: stretches of a wall drawn with MORE parallel lines than the wall's own solid
    # parts (glazing lines added between the faces). Walls are drawn with 2, 3 or more lines
    # depending on the office, so each wall run is compared with its own baseline.
    bandd = lambda b: cv2.dilate(b.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)

    def window(lines, band, horizontal):
        inb = lines & bandd(band)                       # only lines inside the wall band
        rise = np.zeros_like(lines, np.float32)
        if horizontal:
            rise[1:] = (inb[1:] & ~inb[:-1])
            runs = cv2.boxFilter(rise, -1, (1, tmax + 4), normalize=False)
        else:
            rise[:, 1:] = (inb[:, 1:] & ~inb[:, :-1])
            runs = cv2.boxFilter(rise, -1, (tmax + 4, 1), normalize=False)
        win = np.zeros(lines.shape, bool)
        if band.any():
            n, lab, st, _ = cv2.connectedComponentsWithStats(band.astype(np.uint8))
            for i in range(1, n):
                x, y, w, h = st[i, :4]
                sub = lab[y:y + h, x:x + w] == i
                r = runs[y:y + h, x:x + w]
                base = np.percentile(r[sub], 20)       # this wall's own solid-part line count
                win[y:y + h, x:x + w] |= sub & (r >= base + 0.9)
        win = win.astype(np.uint8)
        # a window is a bounded run; a long multi-line run is a wall type (demising, plumbing)
        join = _rect(int(1 * FT * ppm), 1) if horizontal else _rect(1, int(1 * FT * ppm))  # bridge mullions, not piers
        joined = cv2.morphologyEx(win, cv2.MORPH_CLOSE, join)
        n, lab, st, _ = cv2.connectedComponentsWithStats(joined)
        long_ = [i for i in range(1, n) if (st[i, cv2.CC_STAT_WIDTH] if horizontal else st[i, cv2.CC_STAT_HEIGHT]) > window_max * ppm]
        win = win.astype(bool) & ~np.isin(lab, long_)
        k = _rect(2 * clr + 1, 3) if horizontal else _rect(3, 2 * clr + 1)
        return cv2.dilate(win.astype(np.uint8), k).astype(bool), win

    keep_wh, win_h = window(lines_h, wall_h, True)
    keep_wv, win_v = window(lines_v, wall_v, False)
    keepout = keep_h | keep_v | keep_wh | keep_wv
    manual = np.zeros_like(keepout)
    for (x0, y0, x1, y1) in keepouts:  # openings marked by the reviewer, in PDF points
        manual[int(y0 * R.zoom):int(y1 * R.zoom) + 1, int(x0 * R.zoom):int(x1 * R.zoom) + 1] = True
    if manual.any():
        keepout |= cv2.dilate(manual.astype(np.uint8), _rect(2 * clr + 1, 2 * clr + 1)).astype(bool)
    allowed = wall & ~keepout
    return dict(wall=wall, wall_h=wall_h, wall_v=wall_v, keepout=keepout, allowed=allowed,
                windows=win_h | win_v, openings=open_h | open_v)


def footprint(M, R, m_per_pt, close_ft=8.0):
    """Building outline(s) in frame points: walls closed across openings, holes filled.
    Falls back to the convex hull of the walls when the fill leaks (a big gap)."""
    ppm = R.zoom / m_per_pt
    wall = M["wall"].astype(np.uint8)
    if not wall.any():
        return []
    k = max(3, int(close_ft * FT * ppm))
    closed = cv2.morphologyEx(wall, cv2.MORPH_CLOSE, _rect(k, k))
    h, w = closed.shape
    flood = closed.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(flood, mask, (0, 0), 1)                 # outside
    filled = closed | (flood == 0).astype(np.uint8)       # walls + enclosed interiors
    n, lab, st, _ = cv2.connectedComponentsWithStats(filled)
    if n <= 1:
        return []
    areas = st[1:, cv2.CC_STAT_AREA]
    big = [i + 1 for i, a in enumerate(areas) if a >= 0.15 * areas.max() and a * (1 / ppm) ** 2 >= 400 * (FT ** 2)]
    ys, xs = np.nonzero(wall)
    hull_area = cv2.contourArea(cv2.convexHull(np.column_stack([xs, ys]).astype(np.int32)))
    polys = []
    if sum(st[i, cv2.CC_STAT_AREA] for i in big) < 0.35 * hull_area:   # fill leaked: use the hull
        hull = cv2.convexHull(np.column_stack([xs, ys]).astype(np.int32))
        return [[(float(p[0][0]) / R.zoom, float(p[0][1]) / R.zoom) for p in hull]]
    for i in big:
        cnts, _ = cv2.findContours((lab == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(cnts, key=cv2.contourArea)
        c = cv2.approxPolyDP(c, 1.0 * FT * ppm, True)
        polys.append([(float(p[0][0]) / R.zoom, float(p[0][1]) / R.zoom) for p in c])
    return polys


def wall_debug_image(R, M, path):
    img = cv2.cvtColor(R.gray, cv2.COLOR_GRAY2BGR).astype(np.float32)
    for mask, col in ((M["wall"], (60, 200, 60)), (M["keepout"] & M["wall"], (60, 60, 230)),
                      (M["openings"], (0, 180, 255)), (M["windows"], (230, 120, 0))):
        img[mask] = img[mask] * 0.35 + np.array(col) * 0.65
    s = min(1.0, 3000 / R.w)
    cv2.imwrite(path, cv2.resize(img.astype(np.uint8), None, fx=s, fy=s, interpolation=cv2.INTER_AREA))
