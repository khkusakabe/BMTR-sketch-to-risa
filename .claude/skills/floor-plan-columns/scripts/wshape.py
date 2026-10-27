"""Find steel wide-flange (W / I / H) column symbols drawn as outlines in a vector PDF.

A W-shape in plan is a closed 12-sided outline: flange, flange thickness, step in to the
web, web, step out, flange thickness, flange ... with right-angle corners. Many PDFs are
exploded into loose line segments, so segments are chained end to end into closed loops
and each 12-sided loop is checked for the W profile. Works at any rotation.
"""
import math
from collections import defaultdict


def _key(p, tol):
    return (round(p[0] / tol), round(p[1] / tol))


def find_wshapes(page, in_per_pt, inside=lambda x, y: True, min_flange_in=3, max_flange_in=20,
                 min_depth_in=4, max_depth_in=40):
    """Return [{x, y (sheet pt), depth_in, flange_in, web_angle_deg}] for W-shape outlines."""
    tol = 0.08
    segs = []
    for ln in page.lines:
        pts = ln.get("pts") or []
        if len(pts) < 2:
            continue
        a, b = pts[0], pts[-1]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L <= 0 or L * in_per_pt > max_depth_in * 1.2:
            continue
        if not inside((a[0] + b[0]) / 2, (a[1] + b[1]) / 2):
            continue
        segs.append((a, b))
    ends = defaultdict(list)
    for i, (a, b) in enumerate(segs):
        ends[_key(a, tol)].append(i); ends[_key(b, tol)].append(i)
    used, out = set(), []
    for i0 in range(len(segs)):
        if i0 in used:
            continue
        # walk a chain from segment i0
        a, b = segs[i0]
        loop, pts, cur, prev = [i0], [a, b], _key(b, tol), i0
        start = _key(a, tol)
        ok = False
        for _ in range(13):
            nxt = [j for j in ends[cur] if j != prev and j not in loop]
            if cur == start and len(loop) >= 4:
                ok = True; break
            if len(nxt) != 1:
                break
            j = nxt[0]
            p, q = segs[j]
            far = q if _key(p, tol) == cur else p
            loop.append(j); pts.append(far); prev = j; cur = _key(far, tol)
        if cur == start and len(loop) == 12:
            ok = True
        if not ok or len(loop) != 12:
            continue
        used.update(loop)
        poly = pts[:12]
        # right angles at every corner
        vec = [(poly[(k + 1) % 12][0] - poly[k][0], poly[(k + 1) % 12][1] - poly[k][1]) for k in range(12)]
        lens = [math.hypot(*v) for v in vec]
        if min(lens) <= 0:
            continue
        if any(abs(vec[k][0] * vec[(k + 1) % 12][0] + vec[k][1] * vec[(k + 1) % 12][1]) / (lens[k] * lens[(k + 1) % 12]) > 0.12 for k in range(12)):
            continue
        # the two longest segments are the web faces (parallel); flanges are the two widest across
        web_i = sorted(range(12), key=lambda k: -lens[k])[:2]
        wdir = vec[web_i[0]]
        ang = math.atan2(wdir[1], wdir[0])
        ux, uy = math.cos(ang), math.sin(ang)          # along the web (depth direction)
        cx = sum(p[0] for p in poly) / 12; cy = sum(p[1] for p in poly) / 12
        along = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in poly]
        across = [-(p[0] - cx) * uy + (p[1] - cy) * ux for p in poly]
        depth = (max(along) - min(along)) * in_per_pt
        flange = (max(across) - min(across)) * in_per_pt
        web_len = lens[web_i[0]] * in_per_pt
        if not (min_flange_in <= flange <= max_flange_in and min_depth_in <= depth <= max_depth_in):
            continue
        if not (0.5 * depth <= web_len <= depth):      # web is most of the depth
            continue
        out.append(dict(x=cx, y=cy, depth_in=round(depth, 1), flange_in=round(flange, 1),
                        web_angle_deg=round(math.degrees(ang) % 180, 1)))
    return out
