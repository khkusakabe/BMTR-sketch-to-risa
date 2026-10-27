"""Turn a photo of a hand-sketched framing plan into clean line work.

Pipeline: photo -> black/white strokes -> skeleton (scikit-image) -> paths (skan)
-> straight segments -> snap to grid lines -> merged nodes and members.
Coordinates are in image pixels; real lengths come later from the markups.
"""
import base64

import cv2
import numpy as np
from skan import Skeleton
from skimage.morphology import skeletonize

MAX_SIDE = 1600      # resize photos so tolerances behave the same for any camera
SNAP_DEG = 12        # lines within this angle of horizontal/vertical get snapped
INK_RATIO = 0.6      # pixel darker than 60% of the surrounding paper = ink
MIN_RUN = 0.05       # straight run (fraction of image diagonal) needed to count as a line
REACH = 1.0          # a loose beam end may stretch up to this fraction of its length to a support


def _ink(img, diag):
    """Pen strokes as a mask. Each pixel is compared with the paper around it, so
    shadows are ignored and faint ruled notebook lines fall below the cut-off."""
    gray = img.min(axis=2)  # coloured ink (blue pen) shows up dark here
    k = int(diag / 50) | 1
    paper = cv2.morphologyEx(gray, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    ratio = gray.astype(np.float32) / np.maximum(paper, 1)
    ink = ratio < INK_RATIO
    # Blue pen: keep only blue strokes. Ruled notebook lines are grey/brown and can
    # look as dark as the pen in shadow, but they are never blue.
    b, r = img[..., 0].astype(np.int16), img[..., 2].astype(np.int16)
    blue = (b - r) > 8
    if ink.any() and blue[ink].mean() > 0.25:
        ink &= blue
    return ink.astype(np.uint8) * 255


def _long_lines(ink, diag):
    """Keep only long, roughly horizontal/vertical runs of ink. Handwriting and
    column marks are made of short strokes, so they drop out even where they
    sit on top of a frame line."""
    t = max(3, int(diag * 0.003))
    thick = cv2.dilate(ink, np.ones((t, t), np.uint8))  # tolerate wobble and slight slope
    L = int(diag * MIN_RUN) | 1
    out = np.zeros_like(thick)
    # Sketched lines are rarely level, so try line-shaped kernels at a fan of angles.
    for deg in range(-SNAP_DEG, SNAP_DEG + 1, 3):
        for base in (0, 90):
            a = np.radians(base + deg)
            dx, dy = np.cos(a) * L / 2, np.sin(a) * L / 2
            k = np.zeros((L, L), np.uint8)
            c = L // 2
            cv2.line(k, (round(c - dx), round(c - dy)), (round(c + dx), round(c + dy)), 1, 1)
            out |= cv2.morphologyEx(thick, cv2.MORPH_OPEN, k)
    return out > 0


def _segments(skel, diag):
    """Skeleton paths -> straight segments [(x1, y1, x2, y2), ...]."""
    segs = []
    if not skel.any():
        return segs
    sk = Skeleton(skel)
    for i in range(sk.n_paths):
        rc = sk.path_coordinates(i)
        pts = np.round(rc[:, ::-1]).astype(np.int32).reshape(-1, 1, 2)  # (row,col) -> (x,y)
        # Split bent paths (corners, wobbles) into straight pieces.
        poly = cv2.approxPolyDP(pts, diag * 0.012, False).reshape(-1, 2)
        for a, b in zip(poly[:-1], poly[1:]):
            if np.hypot(*(b - a)) >= diag * 0.03:  # short bits are text or pen noise
                segs.append((*a.astype(float), *b.astype(float)))
    return segs


def _cluster(values, weights, tol):
    """1-D clustering: returns the weighted centre of each group of close values."""
    if not values:
        return []
    order = np.argsort(values)
    groups, cur = [], [order[0]]
    for i in order[1:]:
        if values[i] - values[cur[-1]] <= tol:
            cur.append(i)
        else:
            groups.append(cur)
            cur = [i]
    groups.append(cur)
    return [float(np.average([values[i] for i in g], weights=[weights[i] for i in g])) for g in groups]


def _nearest(v, grid, tol):
    if grid:
        g = min(grid, key=lambda c: abs(c - v))
        if abs(g - v) <= tol:
            return g
    return v


def _merge_intervals(items, gap):
    """items: [(level, lo, hi)] on one grid line -> overlapping/near pieces joined."""
    out = []
    for lo, hi in sorted(items):
        if out and lo <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def _intersect(l1, l2, tol):
    """Crossing point of two segments (allowing tol overshoot), or None."""
    x1, y1, x2, y2 = l1
    x3, y3, x4, y4 = l2
    d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if abs(d) < 1e-9:
        return None
    t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    e1 = tol / np.hypot(x2 - x1, y2 - y1)
    e2 = tol / np.hypot(x4 - x3, y4 - y3)
    if -e1 <= t <= 1 + e1 and -e2 <= u <= 1 + e2:
        return x1 + t * (x2 - x1), y1 + t * (y2 - y1)
    return None


def _extend_to_supports(lines, tol, diag):
    """Stretch loose ends of horizontal/vertical lines to the perpendicular line
    they were meant to frame into (sketched beams often stop short of girders)."""
    out = []
    for l in lines:
        x1, y1, x2, y2 = l
        length = np.hypot(x2 - x1, y2 - y1)
        reach = min(REACH * length, 0.1 * diag)
        if y1 == y2:    # horizontal: look for verticals left of x1 and right of x2
            perp = [p for p in lines if p[0] == p[2] and p[1] - tol <= y1 <= p[3] + tol]
            left = [p[0] for p in perp if x1 - reach <= p[0] < x1 - tol]
            right = [p[0] for p in perp if x2 + tol < p[0] <= x2 + reach]
            if left and not any(abs(p[0] - x1) <= tol for p in perp):
                x1 = max(left)
            if right and not any(abs(p[0] - x2) <= tol for p in perp):
                x2 = min(right)
        elif x1 == x2:  # vertical: look for horizontals above y1 and below y2
            perp = [p for p in lines if p[1] == p[3] and p[0] - tol <= x1 <= p[2] + tol]
            up = [p[1] for p in perp if y1 - reach <= p[1] < y1 - tol]
            down = [p[1] for p in perp if y2 + tol < p[1] <= y2 + reach]
            if up and not any(abs(p[1] - y1) <= tol for p in perp):
                y1 = max(up)
            if down and not any(abs(p[1] - y2) <= tol for p in perp):
                y2 = min(down)
        out.append((x1, y1, x2, y2))
    return out


def _build(segs, diag):
    tol = diag * 0.02
    horiz, vert, diag_segs = [], [], []
    for x1, y1, x2, y2 in segs:
        ang = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1))) % 180
        if min(ang, 180 - ang) <= SNAP_DEG:
            horiz.append((x1, y1, x2, y2))
        elif abs(ang - 90) <= SNAP_DEG:
            vert.append((x1, y1, x2, y2))
        else:
            diag_segs.append((x1, y1, x2, y2))

    # Grid lines = clusters of the y of horizontals and x of verticals.
    gy = _cluster([(s[1] + s[3]) / 2 for s in horiz], [abs(s[2] - s[0]) for s in horiz], tol)
    gx = _cluster([(s[0] + s[2]) / 2 for s in vert], [abs(s[3] - s[1]) for s in vert], tol)

    lines = []  # (x1, y1, x2, y2) after snapping and merging
    by_y = {}
    for x1, y1, x2, y2 in horiz:
        y = _nearest((y1 + y2) / 2, gy, tol)
        lo, hi = sorted((_nearest(x1, gx, tol), _nearest(x2, gx, tol)))
        by_y.setdefault(y, []).append((lo, hi))
    for y, ivs in by_y.items():
        lines += [(lo, y, hi, y) for lo, hi in _merge_intervals(ivs, tol)]
    by_x = {}
    for x1, y1, x2, y2 in vert:
        x = _nearest((x1 + x2) / 2, gx, tol)
        lo, hi = sorted((_nearest(y1, gy, tol), _nearest(y2, gy, tol)))
        by_x.setdefault(x, []).append((lo, hi))
    for x, ivs in by_x.items():
        lines += [(x, lo, x, hi) for lo, hi in _merge_intervals(ivs, tol)]
    for x1, y1, x2, y2 in diag_segs:
        lines.append((_nearest(x1, gx, tol), _nearest(y1, gy, tol),
                      _nearest(x2, gx, tol), _nearest(y2, gy, tol)))
    lines = [l for l in lines if np.hypot(l[2] - l[0], l[3] - l[1]) >= tol]
    lines = _extend_to_supports(lines, tol, diag)

    # Nodes: all line ends, merged when close.
    nodes = []
    def node_id(x, y):
        for i, (nx, ny) in enumerate(nodes):
            if np.hypot(nx - x, ny - y) <= tol:
                return i
        nodes.append((x, y))
        return len(nodes) - 1
    ends = [(node_id(l[0], l[1]), node_id(l[2], l[3])) for l in lines]
    # Crossings: where two lines cross mid-span there is no end point, so add a node.
    for p in range(len(lines)):
        for q in range(p + 1, len(lines)):
            pt = _intersect(lines[p], lines[q], tol)
            if pt is not None:
                node_id(*pt)

    # Split members where another member's node lands on them (T-joints, crossings).
    members = set()
    for a, b in ends:
        if a == b:
            continue
        (ax, ay), (bx, by) = nodes[a], nodes[b]
        L = np.hypot(bx - ax, by - ay)
        on = []
        for k, (px, py) in enumerate(nodes):
            if k in (a, b):
                continue
            t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L**2
            dist = abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L
            if 0 < t < 1 and dist <= tol:
                on.append((t, k))
        chain = [a] + [k for _, k in sorted(on)] + [b]
        members.update(tuple(sorted(p)) for p in zip(chain[:-1], chain[1:]))

    # Trim overhangs: short members with a loose end (line drawn past a corner).
    while True:
        deg = {}
        for m in members:
            for n in m:
                deg[n] = deg.get(n, 0) + 1
        stubs = {m for m in members
                 if min(deg[m[0]], deg[m[1]]) == 1
                 and np.hypot(*np.subtract(nodes[m[0]], nodes[m[1]])) < 3 * tol}
        if not stubs:
            break
        members -= stubs

    # Re-number the used nodes row by row (top to bottom, left to right).
    used = sorted({n for m in members for n in m}, key=lambda n: (round(nodes[n][1] / tol), nodes[n][0]))
    remap = {old: i + 1 for i, old in enumerate(used)}
    node_list = [{"id": remap[i], "x": round(nodes[i][0], 1), "y": round(nodes[i][1], 1)} for i in used]
    mem_list = []
    for j, (a, b) in enumerate(sorted(members, key=lambda m: (nodes[m[0]][1], nodes[m[0]][0])), 1):
        (ax, ay), (bx, by) = nodes[a], nodes[b]
        orient = "H" if abs(ay - by) < 1 else "V" if abs(ax - bx) < 1 else "D"
        mem_list.append({"id": j, "i": remap[a], "j": remap[b], "orient": orient,
                         "length_px": round(float(np.hypot(bx - ax, by - ay)), 1)})
    return node_list, mem_list, {"x": [round(v, 1) for v in sorted(gx)], "y": [round(v, 1) for v in sorted(gy)]}


def _overlay(img, skel, nodes, members):
    out = cv2.addWeighted(img, 0.35, np.full_like(img, 255), 0.65, 0)
    out[skel] = (150, 150, 255)  # raw skeleton, light red
    pos = {n["id"]: (int(n["x"]), int(n["y"])) for n in nodes}
    for m in members:
        cv2.line(out, pos[m["i"]], pos[m["j"]], (200, 90, 20), 4, cv2.LINE_AA)
    for m in members:
        (x1, y1), (x2, y2) = pos[m["i"]], pos[m["j"]]
        cv2.putText(out, f"M{m['id']}", ((x1 + x2) // 2 + 6, (y1 + y2) // 2 - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 90, 20), 2, cv2.LINE_AA)
    for n in nodes:
        cv2.circle(out, pos[n["id"]], 7, (30, 140, 30), -1, cv2.LINE_AA)
        cv2.putText(out, f"N{n['id']}", (pos[n["id"]][0] + 8, pos[n["id"]][1] + 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (30, 140, 30), 2, cv2.LINE_AA)
    return out


ROTATIONS = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def process(image_bytes, rotate=0):
    """Return (result dict, overlay PNG bytes) for a sketch photo."""
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not read the image. Use JPG or PNG (iPhone HEIC photos must be converted).")
    if rotate in ROTATIONS:
        img = cv2.rotate(img, ROTATIONS[rotate])
    s = MAX_SIDE / max(img.shape[:2])
    if s < 1:
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    h, w = img.shape[:2]
    diag = float(np.hypot(w, h))

    skel = skeletonize(_long_lines(_ink(img, diag), diag))
    nodes, members, grid = _build(_segments(skel, diag), diag)
    overlay = _overlay(img, skel, nodes, members)
    _, png = cv2.imencode(".png", overlay)
    _, photo = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return ({"width": w, "height": h, "nodes": nodes, "members": members, "grid": grid},
            png.tobytes(), photo.tobytes())


def to_data_url(data, mime="image/png"):
    return f"data:{mime};base64," + base64.b64encode(data).decode()
