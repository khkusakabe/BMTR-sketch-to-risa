/* Column engine: grid-based column layout, DXF writer and zip packer.
 * Shared by the "Column" web app and scripts/column_tool.js, so the app and the
 * DXF Claude sends always agree. Model space is inches, X right, Y up.
 */
(function (root) {
  "use strict";
  const E = {};

  // ------------------------------------------------------------- formatting
  E.ftin = function (inches) {
    const neg = inches < 0;
    let v = Math.abs(inches);
    let ft = Math.floor(v / 12);
    let inch = Math.round((v - ft * 12) * 4) / 4;
    if (inch >= 12) { ft += 1; inch -= 12; }
    const i = Number.isInteger(inch) ? String(inch) : inch.toFixed(2).replace(/0$/, "");
    return (neg ? "-" : "") + (ft ? ft + "'-" + i + '"' : i + '"');
  };

  // ------------------------------------------------------------- grid
  E.lines = function (model, axis) {
    return [...model.grid[axis]].sort((a, b) => a.pos - b.pos);
  };
  E.linePos = function (model, axis, label) {
    const g = model.grid[axis].find((g) => g.label === label);
    return g ? g.pos : 0;
  };
  // Line a position is measured from: nearest if within 2 ft, else the one to the left / below.
  E.refLine = function (lines, v, near = 24) {
    if (!lines.length) return { label: "", pos: 0 };
    let n = lines[0];
    for (const g of lines) if (Math.abs(g.pos - v) < Math.abs(n.pos - v)) n = g;
    if (Math.abs(n.pos - v) <= near) return n;
    const below = lines.filter((g) => g.pos <= v);
    return below.length ? below[below.length - 1] : n;
  };
  E.absolute = function (model, c) {
    return { x: E.linePos(model, "x", c.refX) + c.dx, y: E.linePos(model, "y", c.refY) + c.dy };
  };
  E.gridLabel = function (model, X, Y) {
    const part = (lines, v) => {
      if (!lines.length) return "";
      const n = E.refLine(lines, v);
      if (Math.abs(n.pos - v) <= 24) return n.label;
      for (let i = 0; i + 1 < lines.length; i++)
        if (lines[i].pos < v && v < lines[i + 1].pos) return lines[i].label + "/" + lines[i + 1].label;
      return n.label;
    };
    return [part(E.lines(model, "x"), X), part(E.lines(model, "y"), Y)].filter(Boolean).join("-");
  };
  E.place = function (model, c, X, Y) {
    const rx = E.refLine(E.lines(model, "x"), X), ry = E.refLine(E.lines(model, "y"), Y);
    c.refX = rx.label; c.dx = Math.round((X - rx.pos) * 4) / 4;
    c.refY = ry.label; c.dy = Math.round((Y - ry.pos) * 4) / 4;
    return c;
  };

  // ------------------------------------------------------------- layout
  // Targets: every grid intersection + evenly spaced points so no span exceeds maxSpacing.
  E.targets = function (model, rules) {
    const gx = E.lines(model, "x"), gy = E.lines(model, "y");
    const lim = rules.maxSpacingFt * 12, out = new Map();
    const add = (x, y, label) => { const k = x.toFixed(1) + "," + y.toFixed(1); if (!out.has(k)) out.set(k, { x, y, label }); };
    for (const a of gx) for (const b of gy) add(a.pos, b.pos, a.label + "-" + b.label);
    for (const a of gx) for (let i = 0; i + 1 < gy.length; i++) {
      const b0 = gy[i], b1 = gy[i + 1], n = Math.ceil((b1.pos - b0.pos) / lim - 1e-6);
      for (let k = 1; k < n; k++) add(a.pos, b0.pos + ((b1.pos - b0.pos) * k) / n, a.label + "-" + b0.label + "/" + b1.label);
    }
    for (const b of gy) for (let i = 0; i + 1 < gx.length; i++) {
      const a0 = gx[i], a1 = gx[i + 1], n = Math.ceil((a1.pos - a0.pos) / lim - 1e-6);
      for (let k = 1; k < n; k++) add(a0.pos + ((a1.pos - a0.pos) * k) / n, b.pos, a0.label + "/" + a1.label + "-" + b.label);
    }
    return [...out.values()].sort((p, q) => q.y - p.y || p.x - q.x);
  };

  // point-in-polygon and distance to a polygon's edges (footprint tests)
  E.pip = (poly, x, y) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  E.polyDist = (poly, x, y) => {
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return d;
  };
  const rectDist = (r, x, y) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));

  // Rules: a column at each target, laid out on STRAIGHT column lines. Every target sits on
  // one vertical and one horizontal column line (grid lines plus any extra span lines), and
  // each line gets ONE offset from its grid position, shared by every column on it. Offsets
  // (within maxShift) are chosen together to, in order: hide columns in walls, never block a
  // door or window opening (clearance + radius), and stay close to the grid. Lines that carry
  // a drawn column take that column's offset, so new columns line up with drawn ones.
  E.layout = function (model, rules, column) {
    const r = (column.diaIn || 6) / 2;
    const S = rules.maxShiftFt * 12, clr = rules.clearanceIn + r;
    const kept = model.columns.filter((c) => c.status !== "proposed");
    const keptPts = kept.map((c) => E.absolute(model, c));
    const skip = new Set(model.skipTargets || []);
    const walls = model.walls || [], opens = model.openings || [];
    const clear = (x, y) => opens.every((o) => rectDist(o, x, y) >= clr);
    // distance from the wall centreline if the point is hidden in a wall, else null
    const hidden = (x, y) => {
      let best = null;
      for (const w of walls) {
        const h = w.dir === "h";
        const inLen = h ? x >= w.x0 + r && x <= w.x1 - r : y >= w.y0 + r && y <= w.y1 - r;
        const inThk = h ? y >= w.y0 - 1 && y <= w.y1 + 1 : x >= w.x0 - 1 && x <= w.x1 + 1;
        if (!inLen || !inThk) continue;
        const d = h ? Math.abs(y - (w.y0 + w.y1) / 2) : Math.abs(x - (w.x0 + w.x1) / 2);
        if (best === null || d < best) best = d;
      }
      return best !== null && clear(x, y) ? best : null;
    };
    // building footprint (traced from the walls; else the walls' extent). A column outside it is
    // never acceptable, and grid points well outside it get no column at all.
    const fps = model.footprint && model.footprint.length ? model.footprint : null;
    const fp = walls.length ? walls.reduce((b, w) => ({ x0: Math.min(b.x0, w.x0), y0: Math.min(b.y0, w.y0), x1: Math.max(b.x1, w.x1), y1: Math.max(b.y1, w.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) : null;
    const nearFp = (x, y, tol) => fps.some((p) => E.pip(p, x, y) || E.polyDist(p, x, y) <= tol);
    const inside = (x, y) => (fps ? nearFp(x, y, 6) : !fp || (x >= fp.x0 && x <= fp.x1 && y >= fp.y0 && y <= fp.y1));
    // hidden in a wall (best) < exposed inside < one column blocking an opening < outside the building.
    // Columns that can't be hidden should stay near their grid points, so distance off the grid
    // costs 10 per inch: a line won't slide 3 ft to hide one column and drag the rest off grid.
    const cost = (x, y, d) => {
      if (!inside(x, y)) return 1e6;
      const h = hidden(x, y);
      return h !== null ? 0.3 * h + 0.5 * d : (clear(x, y) ? 1000 : 2500) + 10 * d;
    };

    // lines and their members
    const V = new Map(), H = new Map();
    const line = (map, pos) => { const k = Math.round(pos); if (!map.has(k)) map.set(k, { pos, members: [], anchors: [], off: 0 }); return map.get(k); };
    const free = [];
    // Grid lines closer than minLineFt (8 ft) to a parallel neighbour are one column line
    // (e.g. B and B.1 3'-11" apart): columns go on the line with drawn columns, else the
    // plain-labelled one, never on both.
    const minLine = (rules.minLineFt || 8) * 12;
    const dropped = { x: new Set(), y: new Set() };
    model.mergedLines = [];
    for (const axis of ["x", "y"]) {
      const ls = E.lines(model, axis);
      for (let i = 0; i + 1 < ls.length; i++) {
        const a = ls[i], b = ls[i + 1];
        if (b.pos - a.pos >= minLine || dropped[axis].has(a.label)) continue;
        const drawnOn = (l) => keptPts.filter((p) => Math.abs((axis === "x" ? p.x : p.y) - l.pos) <= 24).length;
        const da = drawnOn(a), db = drawnOn(b);
        const keepA = da !== db ? da > db : (a.label.includes(".") === b.label.includes(".") ? true : !a.label.includes("."));
        const drop = keepA ? b : a;
        dropped[axis].add(drop.label);
        model.mergedLines.push((keepA ? a.label : b.label) + " (" + drop.label + " is " + E.ftin(b.pos - a.pos) + " away: no columns on it)");
      }
    }
    const onDropped = (t) => E.lines(model, "x").some((l) => dropped.x.has(l.label) && Math.abs(l.pos - t.x) < 0.5) ||
                             E.lines(model, "y").some((l) => dropped.y.has(l.label) && Math.abs(l.pos - t.y) < 0.5);
    model.outsideTargets = [];
    for (const t of E.targets(model, rules)) {
      if (skip.has(t.label)) continue;
      if (onDropped(t)) continue;
      if (fps && !nearFp(t.x, t.y, S)) { model.outsideTargets.push(t.label); continue; }   // grid point outside the building
      const v = line(V, t.x), h = line(H, t.y);
      // a drawn column covers a grid point within 1.5 x the shift limit (drawn columns are often a bit off grid)
      const k = keptPts.findIndex((p) => Math.hypot(p.x - t.x, p.y - t.y) <= Math.max(1.5 * S, 12));
      if (k >= 0) { v.anchors.push(keptPts[k].x - t.x); h.anchors.push(keptPts[k].y - t.y); continue; }
      const m = { t, v, h };
      v.members.push(m); h.members.push(m); free.push(m);
    }
    const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const lines = [...V.values()].map((l) => ({ ...l, axis: "x" })).concat([...H.values()].map((l) => ({ ...l, axis: "y" })));
    // re-link members to the copied line objects
    for (const l of lines) for (const m of l.members) m[l.axis === "x" ? "v" : "h"] = l;
    for (const l of lines) { l.fixed = l.anchors.length > 0; l.off = l.fixed ? med(l.anchors) : 0; }
    const pt = (m) => ({ x: m.t.x + m.v.off, y: m.t.y + m.h.off });

    // candidate offsets: 1" steps, plus exact wall centrelines near the line
    for (const l of lines) {
      const c = new Set();
      for (let o = -S; o <= S + 1e-6; o += 1) c.add(Math.round(o * 4) / 4);
      for (const w of walls) {
        if (l.axis === "y" && w.dir === "h") { const o = (w.y0 + w.y1) / 2 - l.pos; if (Math.abs(o) <= S) c.add(Math.round(o * 4) / 4); }
        if (l.axis === "x" && w.dir === "v") { const o = (w.x0 + w.x1) / 2 - l.pos; if (Math.abs(o) <= S) c.add(Math.round(o * 4) / 4); }
      }
      l.cands = [...c].sort((p, q) => Math.abs(p) - Math.abs(q));
    }
    const lineCost = (l, off) => {
      const keep = l.off; l.off = off;
      let s = 0; for (const m of l.members) { const p = pt(m); s += cost(p.x, p.y, Math.hypot(m.v.off, m.h.off)); }
      l.off = keep;
      return s;
    };
    // coordinate descent: improve one line at a time until nothing changes
    for (let it = 0; it < 12; it++) {
      let changed = false;
      for (const l of lines) {
        if (l.fixed || !l.members.length) continue;
        let best = l.off, bc = lineCost(l, l.off);
        for (const o of l.cands) { const c = lineCost(l, o); if (c < bc - 1e-9) { bc = c; best = o; } }
        if (best !== l.off) { l.off = best; changed = true; }
      }
      if (!changed) break;
    }

    const proposed = [];
    for (const m of free) {
      const p = pt(m), c = { id: "", status: "proposed", target: m.t.label };
      E.place(model, c, p.x, p.y);
      const on = "on straight lines" + (Math.abs(m.v.off) + Math.abs(m.h.off) >= 0.5 ? " (" + [m.v.off ? E.ftin(Math.abs(m.v.off)) + (m.v.off > 0 ? " right" : " left") : "", m.h.off ? E.ftin(Math.abs(m.h.off)) + (m.h.off > 0 ? " up" : " down") : ""].filter(Boolean).join(", ") + " from grid point)" : " at grid point");
      if (!inside(p.x, p.y)) { c.placement = "blocked"; c.note = "Falls outside the building on its column lines. Needs a decision."; }
      else if (hidden(p.x, p.y) !== null) { c.placement = "wall"; c.note = "In wall, " + on; }
      else if (clear(p.x, p.y)) { c.placement = "exposed"; c.note = "Exposed: no aligned spot within " + rules.maxShiftFt + " ft is in a wall; " + on; }
      else { c.placement = "blocked"; c.note = "Blocks a door/window opening: no aligned spot within " + rules.maxShiftFt + " ft avoids it. Needs a decision."; }
      proposed.push(c);
    }
    model.lineOffsets = lines.filter((l) => l.members.length || l.fixed).map((l) => ({ axis: l.axis, pos: l.pos, off: l.off, fixed: l.fixed, columns: l.members.length + l.anchors.length }));
    const all = kept.concat(proposed);
    E.number(model, all);
    return all;
  };

  // Number columns C1.. top-left to bottom-right (as the plan reads).
  E.number = function (model, cols) {
    // group by the horizontal grid line each column belongs to (within 4 ft), then left to right
    const gy = E.lines(model, "y");
    const row = (y) => { let best = null; for (const g of gy) if (Math.abs(g.pos - y) <= 48 && (!best || Math.abs(g.pos - y) < Math.abs(best.pos - y))) best = g; return best ? best.pos : y; };
    const pts = cols.map((c) => { const p = E.absolute(model, c); return { c, p, r: row(p.y) }; });
    pts.sort((a, b) => b.r - a.r || a.p.x - b.p.x);
    pts.forEach((o, i) => (o.c.id = "C" + (i + 1)));
    return cols;
  };

  // ------------------------------------------------------------- roof framing
  // Girders span the short direction column to column; beams span between adjacent
  // girder lines at an even spacing between beamMinFt and beamMaxFt, plus beams on
  // the column lines (column to column) when beamsAtColumns is on.
  E.FRAMING_DEFAULTS = { on: true, dir: "auto", beamMinFt: 8, beamMaxFt: 12, beamsAtColumns: true, optimize: true, allowFlip: true };

  function cluster(vals, tol) {           // 1-D clusters -> [{pos, members:[idx]}]
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    const out = [];
    for (const i of idx) {
      const c = out[out.length - 1];
      if (c && vals[i] - c.pos <= tol) { c.members.push(i); c.pos = c.members.reduce((s, k) => s + vals[k], 0) / c.members.length; }
      else out.push({ pos: vals[i], members: [i] });
    }
    return out;
  }
  const median = (a) => { if (!a.length) return Infinity; const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

  E.framing = function (model, cols, opts) {
    const o = { ...E.FRAMING_DEFAULTS, ...(opts || {}) };
    const res = { girders: [], beams: [], bays: [], warnings: [], dir: null };
    const P = cols.map((c) => E.absolute(model, c));
    if (!o.on || P.length < 2) return res;
    const TOL = 48;
    const lx = cluster(P.map((p) => p.x), TOL), ly = cluster(P.map((p) => p.y), TOL);
    const spacing = (cl) => median(cl.slice(1).map((c, i) => c.pos - cl[i].pos));
    const sx = spacing(lx), sy = spacing(ly);
    // girders run along the direction whose column-to-column spacing is shorter
    const dir = o.dir === "x" || o.dir === "y" ? o.dir : (sx <= sy ? "x" : "y");
    res.dir = dir;
    // work in (u along girder, v across); swap for girders running in Y
    const U = (p) => (dir === "x" ? p.x : p.y), V = (p) => (dir === "x" ? p.y : p.x);
    const XY = (u, v) => (dir === "x" ? { x: u, y: v } : { x: v, y: u });
    const lines = (dir === "x" ? ly : lx).filter((l) => l.members.length >= 2);   // girder lines
    const stations = dir === "x" ? lx : ly;                                       // column lines across girders
    const stationOf = new Map(); stations.forEach((s, k) => s.members.forEach((i) => stationOf.set(i, k)));
    const girderLines = lines.map((l) => {
      const pts = l.members.map((i) => ({ i, u: U(P[i]), v: V(P[i]), st: stationOf.get(i) })).sort((a, b) => a.u - b.u);
      return { pos: l.pos, pts };
    }).sort((a, b) => a.pos - b.pos);
    const vAt = (gl, u) => {                // girder centreline v at station u (piecewise linear)
      const p = gl.pts;
      if (u <= p[0].u) return p[0].v;
      for (let k = 0; k + 1 < p.length; k++) if (u <= p[k + 1].u) return p[k].v + ((u - p[k].u) / (p[k + 1].u - p[k].u)) * (p[k + 1].v - p[k].v);
      return p[p.length - 1].v;
    };
    let gN = 0, bN = 0;
    girderLines.forEach((gl, li) => {
      for (let k = 0; k + 1 < gl.pts.length; k++) {
        const a = gl.pts[k], b = gl.pts[k + 1], A = XY(a.u, a.v), B = XY(b.u, b.v);
        res.girders.push({ id: "G" + ++gN, x1: A.x, y1: A.y, x2: B.x, y2: B.y, span: Math.hypot(B.x - A.x, B.y - A.y),
          from: cols[a.i].id, to: cols[b.i].id, line: li, u0: a.u, u1: b.u, bay: a.st + "-" + b.st });
      }
    });
    const minS = o.beamMinFt * 12, maxS = o.beamMaxFt * 12;
    for (let k = 0; k + 1 < girderLines.length; k++) {
      const g1 = girderLines[k], g2 = girderLines[k + 1];
      const lo = Math.max(g1.pts[0].u, g2.pts[0].u), hi = Math.min(g1.pts[g1.pts.length - 1].u, g2.pts[g2.pts.length - 1].u);
      if (hi - lo < 1) { res.warnings.push("Girder lines at " + E.ftin(g1.pos) + " and " + E.ftin(g2.pos) + " don't overlap; no beams framed between them."); continue; }
      // bay boundaries: column lines with a column on both girder lines
      const s1 = new Map(g1.pts.map((p) => [p.st, p])), s2 = new Map(g2.pts.map((p) => [p.st, p]));
      let bounds = [...s1.keys()].filter((s) => s2.has(s)).map((s) => ({ st: s, a: s1.get(s), b: s2.get(s), u: (s1.get(s).u + s2.get(s).u) / 2 })).sort((p, q) => p.u - q.u);
      if (bounds.length < 2) bounds = [{ st: "lo", u: lo }, { st: "hi", u: hi }];
      const pairBeams = [];
      for (let j = 0; j + 1 < bounds.length; j++) {
        const L = bounds[j], R = bounds[j + 1], w = R.u - L.u;
        const stKey = L.st + "-" + R.st, key = k + ":" + stKey;   // one key per bay (girder pair + column lines)
        let n = E.beamCounts(w, o)[0] || Math.max(1, Math.floor(w / minS));
        if (o.counts && o.counts[key]) n = o.counts[key];
        const sp = w / n;
        const bay = { key, stKey, pair: k, from: g1.pos, to: g2.pos, u0: L.u, width: w, spacing: sp, count: n - 1, span: 0, ok: sp >= minS - 1e-6 && sp <= maxS + 1e-6 };
        if (!bay.ok) res.warnings.push("Bay " + E.ftin(w) + " wide can't take beams at " + o.beamMinFt + "-" + o.beamMaxFt + " ft; used " + E.ftin(sp) + " o.c.");
        const add = (u, onCol, pa, pb) => {
          const A = pa ? XY(pa.u, pa.v) : XY(u, vAt(g1, u)), B = pb ? XY(pb.u, pb.v) : XY(u, vAt(g2, u));
          const span = Math.hypot(B.x - A.x, B.y - A.y); bay.span = Math.max(bay.span, span);
          const m = { id: "B" + ++bN, x1: A.x, y1: A.y, x2: B.x, y2: B.y, span, onColumnLine: onCol, pair: k, u, bay: onCol ? "col" : key };
          res.beams.push(m); pairBeams.push(m);
        };
        if (o.beamsAtColumns && j === 0 && L.a) add(L.u, true, L.a, L.b);
        for (let m = 1; m < n; m++) add(L.u + sp * m, false);
        if (o.beamsAtColumns && R.a) add(R.u, true, R.a, R.b);
        res.bays.push(bay);
      }
      // tributary width of each beam: half the distance to its neighbours (edges at the framed extent)
      pairBeams.sort((p, q) => p.u - q.u);
      const e0 = bounds[0].u, e1 = bounds[bounds.length - 1].u;
      pairBeams.forEach((m, i) => {
        const prev = i > 0 ? pairBeams[i - 1].u : e0, next = i + 1 < pairBeams.length ? pairBeams[i + 1].u : e1;
        m.trib = (m.u - prev) / 2 + (next - m.u) / 2;
      });
    }
    res.lines = girderLines.map((g) => g.pos);
    return res;
  };

  // ------------------------------------------------------------- member sizing + optimization
  // Preliminary sizing for layout decisions only (not a substitute for the engineer of record).
  // [shape, weight plf, Zx in^3, Ix in^4]  (AISC Manual, Table 1-1)
  E.W_SHAPES = [
    ["W8x10", 10, 8.87, 30.8], ["W10x12", 12, 12.6, 53.8], ["W8x13", 13, 11.4, 39.6], ["W12x14", 14, 17.4, 88.6],
    ["W10x15", 15, 16.0, 68.9], ["W12x16", 16, 20.1, 103], ["W8x18", 18, 17.0, 61.9], ["W10x19", 19, 21.6, 96.3],
    ["W12x19", 19, 24.7, 130], ["W10x22", 22, 26.0, 118], ["W12x22", 22, 29.3, 156], ["W14x22", 22, 33.2, 199],
    ["W12x26", 26, 37.2, 204], ["W14x26", 26, 40.2, 245], ["W16x26", 26, 44.2, 301], ["W14x30", 30, 47.3, 291],
    ["W16x31", 31, 54.0, 375], ["W18x35", 35, 66.5, 510], ["W16x36", 36, 64.0, 448], ["W18x40", 40, 78.4, 612],
    ["W21x44", 44, 95.4, 843], ["W18x46", 46, 90.7, 712], ["W21x50", 50, 110, 984], ["W24x55", 55, 134, 1350],
    ["W21x57", 57, 129, 1170], ["W24x62", 62, 153, 1550], ["W24x68", 68, 177, 1830], ["W24x76", 76, 200, 2100],
    ["W27x84", 84, 244, 2850], ["W30x90", 90, 283, 3610], ["W27x94", 94, 278, 3270], ["W30x99", 99, 312, 3990],
    ["W33x118", 118, 415, 5900],
  ].sort((a, b) => a[1] - b[1] || a[2] - b[2]);
  E.ROOF_DEFAULTS = { deadPsf: 20, livePsf: 20, Fy: 50, Es: 29000, llDefl: 240, tlDefl: 180, girderLtb: 0.9 };

  // lightest shape with phi*Mn >= Mu(wt) and I >= Ireq(wt)
  function pick(MuFn, IreqFn, factor, roof) {
    for (const [name, wt, Zx, Ix] of E.W_SHAPES) {
      if (0.9 * roof.Fy * Zx * factor >= MuFn(wt) && Ix >= IreqFn(wt)) return { name, wt };
    }
    return null;
  }

  E.sizeFraming = function (fr, roofIn) {
    const roof = { ...E.ROOF_DEFAULTS, ...(roofIn || {}) }, Es = roof.Es;
    const psf = (q, trib) => (q * trib) / 144000;            // psf over trib (in) -> kip/in
    const plf = (wt) => wt / 12000;                          // plf -> kip/in
    let lbs = 0, failed = 0;
    for (const m of fr.beams) {
      const L = m.span, wDs = psf(roof.deadPsf, m.trib || 0), wL = psf(roof.livePsf, m.trib || 0);
      const s = pick(
        (wt) => ((1.2 * (wDs + plf(wt)) + 1.6 * wL) * L * L) / 8,
        (wt) => Math.max((5 * wL * L ** 3 * roof.llDefl) / (384 * Es), (5 * (wDs + plf(wt) + wL) * L ** 3 * roof.tlDefl) / (384 * Es)),
        1, roof);
      m.size = s ? s.name : "NO W-SHAPE"; m.wt = s ? s.wt : 0; failed += s ? 0 : 1;
      m.RD = ((wDs + plf(m.wt)) * L) / 2; m.RL = (wL * L) / 2;   // end reactions, kips
      m.lbs = (m.wt * L) / 12; lbs += m.lbs;
    }
    for (const g of fr.girders) {
      const L = g.span, pts = [];
      for (const m of fr.beams) {
        const onThis = m.pair === g.line || m.pair + 1 === g.line;
        if (!onThis || m.u < Math.min(g.u0, g.u1) - 1 || m.u > Math.max(g.u0, g.u1) + 1) continue;
        const a = Math.min(Math.max(Math.abs(m.u - g.u0), 0), L);
        if (a < 1 || a > L - 1) continue;                       // frames into the column, no girder moment
        pts.push({ a, D: m.RD, L: m.RL });
      }
      const moment = (wt) => {
        const ws = 1.2 * plf(wt), P = pts.map((p) => ({ a: p.a, P: 1.2 * p.D + 1.6 * p.L }));
        const RA = P.reduce((s, p) => s + (p.P * (L - p.a)) / L, 0) + (ws * L) / 2;
        let M = 0;
        for (const x of [L / 2, ...P.map((p) => p.a)]) {
          const Mx = RA * x - P.reduce((s, p) => s + (x > p.a ? p.P * (x - p.a) : 0), 0) - (ws * x * x) / 2;
          M = Math.max(M, Mx);
        }
        return M;
      };
      const deflI = (loads, w) => {   // midspan deflection x I
        let d = 0;
        for (const p of loads) { const a = Math.min(p.a, L - p.a); d += (p.P * a * (3 * L * L - 4 * a * a)) / (48 * Es); }
        return d + (5 * w * L ** 4) / (384 * Es);
      };
      const s = pick(moment,
        (wt) => Math.max(
          deflI(pts.map((p) => ({ a: p.a, P: p.L })), 0) / (L / roof.llDefl),
          deflI(pts.map((p) => ({ a: p.a, P: p.D + p.L })), plf(wt)) / (L / roof.tlDefl)),
        roof.girderLtb, roof);
      g.size = s ? s.name : "NO W-SHAPE"; g.wt = s ? s.wt : 0; failed += s ? 0 : 1;
      g.lbs = (g.wt * L) / 12; lbs += g.lbs;
    }
    const area = fr.bays.reduce((s, b) => s + b.width * b.span, 0) / 144;
    fr.steel = { lbs, area, psf: area ? lbs / area : 0, failed, roof };
    return fr.steel;
  };

  // Lightest layout: every girder direction allowed and, per bay, every beam count in the window.
  // Bays are independent (a girder spans one bay), so each bay's count is chosen on its own.
  E.optimize = function (model, cols, framingOpts, roof) {
    const o = { ...E.FRAMING_DEFAULTS, ...(framingOpts || {}) };
    const dirs = o.allowFlip === false ? [null] : ["x", "y"];
    const results = [];
    for (const d of dirs) {
      const base = { ...o, dir: d || o.dir, counts: {} };
      const fr0 = E.framing(model, cols, base);
      if (!fr0.girders.length) continue;
      // Each bay is chosen in turn (a girder carries the bays on both sides, so the
      // weight counted for a bay is its beams plus the two girders that carry them).
      const counts = {}, perBay = [];
      for (const b0 of fr0.bays) {
        const key = b0.key;
        let opts = E.beamCounts(b0.width, o);
        if (!opts.length) opts = [b0.count + 1];
        const carries = (g) => (g.line === b0.pair || g.line === b0.pair + 1) && g.bay === b0.stKey;
        const tried = opts.map((n) => {
          const fr = E.framing(model, cols, { ...base, counts: { ...counts, [key]: n } });
          E.sizeFraming(fr, roof);
          const mine = fr.beams.filter((m) => m.bay === key).concat(fr.girders.filter(carries));
          return { n, lbs: mine.reduce((s, m) => s + m.lbs, 0), fail: mine.filter((m) => !m.wt).length };
        }).sort((a, b) => a.fail - b.fail || a.lbs - b.lbs);
        counts[key] = tried[0].n;
        perBay.push({ key, width: b0.width, tried });
      }
      const fr = E.framing(model, cols, { ...base, counts });
      E.sizeFraming(fr, roof);
      results.push({ dir: fr.dir, counts, perBay, steel: fr.steel, framing: fr });
    }
    results.sort((a, b) => a.steel.failed - b.steel.failed || a.steel.lbs - b.steel.lbs);
    // keep the short-direction rule unless flipping saves more than flipTolerance (default 3%)
    let best = results[0], note = "";
    const shortDir = E.framing(model, cols, { ...o, dir: "auto" }).dir;
    const short = results.find((r) => r.dir === shortDir);
    if (best && short && best !== short && !short.steel.failed) {
      const saving = (short.steel.lbs - best.steel.lbs) / short.steel.lbs;
      if (saving < (o.flipTolerance ?? 0.03)) { note = "Girders kept in the short direction: the long direction saves only " + (saving * 100).toFixed(1) + "%."; best = short; }
      else note = "Girders run the long direction: " + (saving * 100).toFixed(1) + "% lighter than the short direction.";
    }
    return { best, results, note, shortDir };
  };

  // Framing as the settings ask: optimized, or fixed spacing; always sized.
  E.resolveFraming = function (model, cols) {
    const o = { ...E.FRAMING_DEFAULTS, ...(model.framing || {}) };
    if (!o.on) return E.framing(model, cols, o);
    if (o.optimize) {
      const opt = E.optimize(model, cols, o, model.roof);
      if (opt.best) { const fr = opt.best.framing; fr.optimization = opt; return fr; }
    }
    const fr = E.framing(model, cols, o);
    E.sizeFraming(fr, model.roof);
    return fr;
  };

  // Beam counts (spaces per bay) that keep spacing within the min-max window, fewest first.
  E.beamCounts = function (w, o) {
    const minS = o.beamMinFt * 12, maxS = o.beamMaxFt * 12, out = [];
    for (let n = Math.max(1, Math.ceil(w / maxS - 1e-6)); w / n >= minS - 1e-6; n++) out.push(n);
    return out;
  };

  // ------------------------------------------------------------- DXF (R12, inches)
  // One wing: E.toDXF(model, cols, column). Several wings (grids at different angles):
  // E.toDXFWings([{model, cols, column}, ...]); each wing is drawn in its own grid frame and
  // placed by model.frame {angleDeg, ox, oy} (building inches), relative to the first wing.
  E.toDXF = function (model, cols, column) { return E.toDXFWings([{ model, cols, column }]); };

  E.toDXFWings = function (wings) {
    const body = [];
    const g = (code, v) => body.push(String(code), String(v));
    const n = (v) => (Math.round(v * 10000) / 10000).toString();
    const ext3 = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, z: 0 };
    const grow = (x, y) => { ext3.x0 = Math.min(ext3.x0, x); ext3.y0 = Math.min(ext3.y0, y); ext3.x1 = Math.max(ext3.x1, x); ext3.y1 = Math.max(ext3.y1, y); };
    const ref = (wings[0].model.frame) || { angleDeg: 0, ox: 0, oy: 0 };
    let ltscale = 12;
    const multi = wings.length > 1;

    for (const W of wings) {
      const model = W.model, cols = W.cols, column = W.column || model.column || {};
      const f = model.frame || { angleDeg: 0, ox: 0, oy: 0 };
      const A = multi ? (f.angleDeg * Math.PI) / 180 : 0, ca = Math.cos(A), sa = Math.sin(A);   // one wing: draw square to its own grid
      const tx = multi ? f.ox - ref.ox : 0, ty = multi ? f.oy - ref.oy : 0;
      const T = (x, y) => { const X = x * ca - y * sa + tx, Y = x * sa + y * ca + ty; grow(X, Y); return [X, Y]; };
      const rotA = multi ? f.angleDeg : 0;

      const gx = E.lines(model, "x"), gy = E.lines(model, "y");
      const xs = gx.map((l) => l.pos), ys = gy.map((l) => l.pos);
      const pts = cols.map((c) => E.absolute(model, c));
      const minX = Math.min(...xs, ...pts.map((p) => p.x)), maxX = Math.max(...xs, ...pts.map((p) => p.x));
      const minY = Math.min(...ys, ...pts.map((p) => p.y)), maxY = Math.max(...ys, ...pts.map((p) => p.y));
      const span = Math.max(maxX - minX, maxY - minY, 240);
      const ext = Math.max(60, span * 0.06);           // grid line overrun past outer lines
      const bub = Math.max(18, Math.round(span / 60)); // bubble radius
      const txt = bub * 0.9, dimTxt = Math.max(6, bub * 0.45);
      const r = (column.diaIn || 6) / 2, height = (column.heightFt || 14) * 12;
      ext3.z = Math.max(ext3.z, height); ltscale = Math.max(ltscale, span / 40);
      const fr = E.resolveFraming(model, cols);
      const line = (layer, x1, y1, x2, y2, z = 0) => { const [a1, b1] = T(x1, y1), [a2, b2] = T(x2, y2); g(0, "LINE"); g(8, layer); g(10, n(a1)); g(20, n(b1)); g(30, n(z)); g(11, n(a2)); g(21, n(b2)); g(31, n(z)); };
      const lineT = (layer, x1, y1, x2, y2, thick) => { const [a1, b1] = T(x1, y1), [a2, b2] = T(x2, y2); g(0, "LINE"); g(8, layer); g(39, n(thick)); g(10, n(a1)); g(20, n(b1)); g(30, 0); g(11, n(a2)); g(21, n(b2)); g(31, 0); };
      const circle = (layer, x, y, rad, thick) => { const [a1, b1] = T(x, y); g(0, "CIRCLE"); g(8, layer); if (thick) g(39, n(thick)); g(10, n(a1)); g(20, n(b1)); g(30, 0); g(40, n(rad)); };
      const text = (layer, x, y, h, s, rot = 0, center = true, z = 0) => {
        const [a1, b1] = T(x, y), ro = rot + rotA;
        g(0, "TEXT"); g(8, layer); g(10, n(a1)); g(20, n(b1)); g(30, n(z)); g(40, n(h)); g(1, s);
        if (ro) g(50, n(ro));
        if (center) { g(72, 1); g(11, n(a1)); g(21, n(b1)); g(31, n(z)); }
      };
      const rect = (layer, o) => { line(layer, o.x0, o.y0, o.x1, o.y0); line(layer, o.x1, o.y0, o.x1, o.y1); line(layer, o.x1, o.y1, o.x0, o.y1); line(layer, o.x0, o.y1, o.x0, o.y0); };

      const gTop = maxY + ext, gBot = minY - ext, gLeft = minX - ext, gRight = maxX + ext;
      for (const l of gx) {
        line("S-GRID", l.pos, gBot, l.pos, gTop);
        circle("S-GRID-IDEN", l.pos, gTop + bub, bub);
        text("S-GRID-IDEN", l.pos, gTop + bub - txt / 2, txt, l.label);
      }
      for (const l of gy) {
        line("S-GRID", gLeft, l.pos, gRight, l.pos);
        circle("S-GRID-IDEN", gLeft - bub, l.pos, bub);
        text("S-GRID-IDEN", gLeft - bub, l.pos - txt / 2, txt, l.label);
      }
      // dimension strings: bay spacings and overall, above (x) and left (y)
      const tick = dimTxt * 0.8;
      const dimRow = (vals, at, horiz) => {
        for (let i = 0; i + 1 < vals.length; i++) {
          const a = vals[i], b = vals[i + 1], m = (a + b) / 2;
          if (horiz) { line("S-ANNO-DIMS", a, at, b, at); text("S-ANNO-DIMS", m, at + dimTxt * 0.4, dimTxt, E.ftin(b - a)); }
          else { line("S-ANNO-DIMS", at, a, at, b); text("S-ANNO-DIMS", at - dimTxt * 0.4, m, dimTxt, E.ftin(b - a), 90); }
        }
        for (const v of vals) {
          if (horiz) line("S-ANNO-DIMS", v - tick, at - tick, v + tick, at + tick);
          else line("S-ANNO-DIMS", at - tick, v - tick, at + tick, v + tick);
        }
      };
      if (xs.length > 1) { dimRow(xs, maxY + ext * 0.35, true); if (xs.length > 2) dimRow([xs[0], xs[xs.length - 1]], maxY + ext * 0.7, true); }
      if (ys.length > 1) { dimRow(ys, minX - ext * 0.35, false); if (ys.length > 2) dimRow([ys[0], ys[ys.length - 1]], minX - ext * 0.7, false); }
      for (const w of model.walls || []) rect("A-WALL-REF", w);  // walls traced from the PDF, for reference
      const pre = multi && model.wing ? model.wing.replace(/\s*wing\s*/i, "").trim().slice(0, 3).toUpperCase() + "-" : "";
      cols.forEach((c, i) => {
        const p = pts[i];
        const layer = c.status === "existing" ? "S-COLS" : "S-COLS-NEW";
        if (c.shape && c.shape.type === "W") {
          // I / H outline: depth along the web, flange across it; extruded copy for 3D
          const D = c.shape.depthIn, B = c.shape.flangeIn, tf = Math.max(0.5, D * 0.06), tw = Math.max(0.4, D * 0.04);
          const P = [[-B / 2, -D / 2], [B / 2, -D / 2], [B / 2, -D / 2 + tf], [tw / 2, -D / 2 + tf], [tw / 2, D / 2 - tf], [B / 2, D / 2 - tf],
                     [B / 2, D / 2], [-B / 2, D / 2], [-B / 2, D / 2 - tf], [-tw / 2, D / 2 - tf], [-tw / 2, -D / 2 + tf], [-B / 2, -D / 2 + tf]]
            .map(([u, v]) => (c.shape.orient === "H" ? [p.x + v, p.y + u] : [p.x + u, p.y + v]));
          for (let k = 0; k < P.length; k++) {
            const [ax, ay] = P[k], [bx, by] = P[(k + 1) % P.length];
            line(layer, ax, ay, bx, by);
            lineT("S-COLS-3D", ax, ay, bx, by, height);
          }
        } else {
          circle(layer, p.x, p.y, r);
          line(layer, p.x - r, p.y, p.x + r, p.y); line(layer, p.x, p.y - r, p.x, p.y + r);
          circle("S-COLS-3D", p.x, p.y, r, height);
        }
        const tag = pre + c.id + (c.placement === "exposed" ? " (EXPOSED)" : c.placement === "blocked" ? " (BLOCKS OPENING)" : "");
        text("S-COLS-IDEN", p.x + r + dimTxt * 0.4, p.y + r + dimTxt * 0.2, dimTxt, tag, 0, false);
      });
      // roof framing at top of steel = story height
      for (const m of fr.girders) {
        line("S-FRAM-GIRD", m.x1, m.y1, m.x2, m.y2, height);
        const ang = (Math.atan2(m.y2 - m.y1, m.x2 - m.x1) * 180) / Math.PI, up = ang > 90 || ang < -90 ? ang + 180 : ang;
        const nx = -Math.sin((up * Math.PI) / 180), ny = Math.cos((up * Math.PI) / 180);
        text("S-FRAM-IDEN", (m.x1 + m.x2) / 2 + nx * dimTxt * 0.9, (m.y1 + m.y2) / 2 + ny * dimTxt * 0.9, dimTxt * 0.8, pre + m.id + " " + (m.size || "") + " (" + E.ftin(m.span) + ")", up, true, height);
      }
      for (const m of fr.beams) {
        line("S-FRAM-BEAM", m.x1, m.y1, m.x2, m.y2, height);
        if (!m.size) continue;
        const ang = (Math.atan2(m.y2 - m.y1, m.x2 - m.x1) * 180) / Math.PI, up = ang > 90 || ang < -90 ? ang + 180 : ang;
        const nx = -Math.sin((up * Math.PI) / 180), ny = Math.cos((up * Math.PI) / 180);
        // size label a third of the way along, so it clears the bay spacing label
        text("S-FRAM-IDEN", m.x1 + (m.x2 - m.x1) * 0.3 + nx * dimTxt * 0.6, m.y1 + (m.y2 - m.y1) * 0.3 + ny * dimTxt * 0.6, dimTxt * 0.65, m.size, up, true, height);
      }
      // one spacing label per bay, in the first space of the bay
      for (const b of fr.bays) {
        const u = b.u0 + b.spacing / 2, v = (b.from + b.to) / 2, label = "BEAMS @ " + E.ftin(b.spacing) + " O.C.";
        if (fr.dir === "x") text("S-FRAM-IDEN", u, v, dimTxt * 0.8, label, 90, true, height);
        else text("S-FRAM-IDEN", v, u, dimTxt * 0.8, label, 0, true, height);
      }
      if (fr.girders.length) {
        const st = fr.steel, rf = (st && st.roof) || {};
        const notes = [
          (multi && model.wing ? model.wing.toUpperCase() + ": " : "") + "ROOF FRAMING AT T.O. STEEL = +" + E.ftin(height) + " (STORY HEIGHT). GIRDERS SPAN BETWEEN COLUMNS ALONG THE " + (fr.dir === "x" ? "HORIZONTAL" : "VERTICAL") + " GRID LINES" + (multi ? " OF THIS WING." : "."),
          st ? "PRELIMINARY SIZES: DL " + rf.deadPsf + " PSF, ROOF LL " + rf.livePsf + " PSF, FY " + rf.Fy + " KSI, LRFD, DEFL L/" + rf.llDefl + " LL, L/" + rf.tlDefl + " TOTAL. STEEL " + Math.round(st.lbs).toLocaleString("en-US") + " LB = " + st.psf.toFixed(2) + " PSF." : "",
          "FOR LAYOUT ONLY - MEMBER SIZES AND CONNECTIONS BY ENGINEER OF RECORD.",
        ].filter(Boolean);
        notes.forEach((t, i) => text("S-FRAM-IDEN", minX - ext, maxY + ext + 3 * bub + (notes.length - 1 - i) * dimTxt * 1.6, dimTxt, t, 0, false, height));
      }
    }

    const out = [];
    const h = (code, v) => out.push(String(code), String(v));
    const layers = [
      ["S-GRID", 8, "DASHED"], ["S-GRID-IDEN", 7, "CONTINUOUS"], ["S-ANNO-DIMS", 3, "CONTINUOUS"],
      ["A-WALL-REF", 9, "CONTINUOUS"],
      ["S-COLS", 4, "CONTINUOUS"], ["S-COLS-NEW", 1, "CONTINUOUS"], ["S-COLS-IDEN", 7, "CONTINUOUS"],
      ["S-COLS-3D", 4, "CONTINUOUS"],
      ["S-FRAM-GIRD", 6, "CONTINUOUS"], ["S-FRAM-BEAM", 5, "CONTINUOUS"], ["S-FRAM-IDEN", 7, "CONTINUOUS"],
    ];
    h(0, "SECTION"); h(2, "HEADER");
    h(9, "$ACADVER"); h(1, "AC1009");
    h(9, "$INSUNITS"); h(70, 1);        // inches
    h(9, "$LUNITS"); h(70, 4);          // architectural
    h(9, "$LUPREC"); h(70, 4);
    h(9, "$EXTMIN"); h(10, n(ext3.x0)); h(20, n(ext3.y0)); h(30, 0);
    h(9, "$EXTMAX"); h(10, n(ext3.x1)); h(20, n(ext3.y1)); h(30, n(ext3.z));
    h(9, "$LTSCALE"); h(40, n(ltscale));
    h(0, "ENDSEC");
    h(0, "SECTION"); h(2, "TABLES");
    h(0, "TABLE"); h(2, "LTYPE"); h(70, 2);
    h(0, "LTYPE"); h(2, "CONTINUOUS"); h(70, 0); h(3, "Solid line"); h(72, 65); h(73, 0); h(40, 0);
    h(0, "LTYPE"); h(2, "DASHED"); h(70, 0); h(3, "__ __ __"); h(72, 65); h(73, 2); h(40, 0.75); h(49, 0.5); h(49, -0.25);
    h(0, "ENDTAB");
    h(0, "TABLE"); h(2, "LAYER"); h(70, layers.length);
    for (const [name, color, lt] of layers) { h(0, "LAYER"); h(2, name); h(70, 0); h(62, color); h(6, lt); }
    h(0, "ENDTAB");
    h(0, "TABLE"); h(2, "STYLE"); h(70, 1);
    h(0, "STYLE"); h(2, "STANDARD"); h(70, 0); h(40, 0); h(41, 1); h(50, 0); h(71, 0); h(42, 6); h(3, "txt"); h(4, "");
    h(0, "ENDTAB");
    h(0, "ENDSEC");
    h(0, "SECTION"); h(2, "ENTITIES");
    return out.concat(body, ["0", "ENDSEC", "0", "EOF"]).join("\r\n") + "\r\n";
  };

  // ------------------------------------------------------------- structural model (for RISA-3D)
  // Nodes, members and supports in building inches: X, Y in plan (as the DXF), Z up.
  // Columns: base node at Z=0 (pinned) to top node at Z=story height. Girders: column top to
  // column top. Beams: girder line to girder line at roof level; their end nodes sit on the
  // girders, which are physical members so RISA connects them. Wings are placed by model.frame.
  E.structModel = function (wings, opts) {
    const o = Object.assign({ columnShape: "W10x33", tol: 0.5 }, opts || {});
    const nodes = [], members = [], supports = [];
    const multi = wings.length > 1;
    const ref = (wings[0].model.frame) || { angleDeg: 0, ox: 0, oy: 0 };
    const nodeAt = (x, y, z) => {
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        if (Math.abs(nd.x - x) <= o.tol && Math.abs(nd.y - y) <= o.tol && Math.abs(nd.z - z) <= o.tol) return i;
      }
      nodes.push({ label: "N" + (nodes.length + 1), x, y, z });
      return nodes.length - 1;
    };
    const add = (type, i, j, shape, wing, src) => {
      if (i === j) return;
      members.push({ label: "M" + (members.length + 1), type, i, j, shape, wing, src });
    };
    for (const W of wings) {
      const model = W.model, cols = W.cols, column = W.column || model.column || {};
      const f = model.frame || { angleDeg: 0, ox: 0, oy: 0 };
      const A = multi ? (f.angleDeg * Math.PI) / 180 : 0, ca = Math.cos(A), sa = Math.sin(A);
      const tx = multi ? f.ox - ref.ox : 0, ty = multi ? f.oy - ref.oy : 0;
      const T = (x, y) => [x * ca - y * sa + tx, x * sa + y * ca + ty];
      const H = (column.heightFt || 14) * 12;
      const wing = model.wing || "";
      for (const c of cols) {
        const p = E.absolute(model, c), [X, Y] = T(p.x, p.y);
        const b = nodeAt(X, Y, 0), t = nodeAt(X, Y, H);
        supports.push(b);
        add("column", b, t, o.columnShape, wing, c.id);
      }
      const fr = E.resolveFraming(model, cols);
      for (const g of fr.girders) {
        const [x1, y1] = T(g.x1, g.y1), [x2, y2] = T(g.x2, g.y2);
        add("girder", nodeAt(x1, y1, H), nodeAt(x2, y2, H), g.size, wing, g.id);
      }
      for (const m of fr.beams) {
        const [x1, y1] = T(m.x1, m.y1), [x2, y2] = T(m.x2, m.y2);
        add("beam", nodeAt(x1, y1, H), nodeAt(x2, y2, H), m.size, wing, m.id);
      }
    }
    return { nodes, members, supports: [...new Set(supports)], units: "in" };
  };

  // ------------------------------------------------------------- RISA-3D (.r3d) writer
  // Template-driven: a small model saved from the user's own RISA-3D supplies the header,
  // units, codes, materials, label widths and one column + one beam record of every member
  // section. Everything is kept verbatim except NODES, BOUNDARY_CONDITIONS, SHAPES_LIST and
  // the MEMBERS sections, which are regenerated from E.structModel with matching counts.
  // W-shape records not in the template are built from the AISC table (aisc_w_shapes.csv):
  // A d tw bf tf rT Ix Iy Zx Zy J Cw Wno Sw1 Qf Qw kdes k1 0 kdet 0 0 0 7 (verified against
  // RISA-written records; rT is computed, RISA's stored rT can differ by a few percent).
  E.parseShapeTable = function (csvText) {
    const t = {}; let head = null;
    for (const line of csvText.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const c = line.split(",");
      if (!head) { head = c; continue; }
      const r = {}; head.forEach((h, i) => (r[h] = h === "shape" ? c[i] : parseFloat(c[i]) || 0));
      t[r.shape] = r;
    }
    return t;
  };

  E.toR3D = function (wings, templateText, shapeTable, opts) {
    const o = Object.assign({ columnShape: "W10x33" }, opts || {});
    const sm = E.structModel(wings, { columnShape: o.columnShape });
    const T = templateText.replace(/\r\n/g, "\n");
    const block = (tag) => {                       // [TAG] <n> ... [END_TAG]  (tag may start with '.')
      const esc = tag.replace(/[.[\]]/g, (m) => "\\" + m);
      const end = tag.startsWith(".") ? "." + "END_" + tag.slice(1) : "END_" + tag;
      const re = new RegExp("\\[" + esc + "\\][^\\n]*\\n([\\s\\S]*?)\\[" + end.replace(/\./g, "\\.") + "\\]");
      const m = re.exec(T);
      return m ? { start: m.index, end: m.index + m[0].length, body: m[1] } : null;
    };
    const lines = (b) => (b ? b.body.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")) : []);
    // label widths: shape (e), design list (f), node (h), member (i)
    const LL = (lines(block("LABEL_LENGTHS"))[0] || "").replace(";", "").trim().split(/\s+/).map(Number);
    const W = { shape: LL[4] || 32, node: LL[7] || 32, member: LL[8] || 32 };
    const lab = (s, w) => '"' + String(s).slice(0, w).padEnd(w) + '"';
    // length unit (UNITS field b): 0 ft, 1 in, 2 m, 3 cm, 4 mm
    const U = (lines(block("UNITS"))[0] || "0 0").replace(";", "").trim().split(/\s+/).map(Number);
    const k = [1 / 12, 1, 0.0254, 2.54, 25.4][U[1] || 0] || 1 / 12;
    const exp = (v) => {
      let s = Math.abs(v) < 1e-12 ? "0.000000000000e+00" : v.toExponential(12).replace(/e([+-])(\d)$/, "e$10$2");
      return (s.startsWith("-") ? "  " : "   ") + s;
    };
    const quoted = (l) => { const q = []; l.replace(/"([^"]*)"/g, (m, s) => q.push(s)); return q; };
    const afterQuotes = (l) => l.slice(l.lastIndexOf('"') + 1).replace(/;\s*$/, "").trim().split(/\s+/);

    // template nodes / members, to read the vertical axis and the prototype records
    const tNodes = lines(block("NODES")).map((l) => afterQuotes(l).map(Number));
    const tNodeTail = lines(block("NODES")).map((l) => afterQuotes(l).slice(4).join(" "));
    const tMain = lines(block(".MEMBERS_MAIN_DATA"));
    const tDes = lines(block(".MEMBERS_DESIGN_PARAMETERS"));
    const typeOf = (label) => { const d = tDes.find((l) => quoted(l)[0].trim() === label); return d ? Number(afterQuotes(d)[0]) : 1; };
    const tLabels = tMain.map((l) => quoted(l)[0].trim());
    let colIdx = tLabels.findIndex((s) => typeOf(s) === 2), beamIdx = tLabels.findIndex((s) => typeOf(s) === 1);
    if (colIdx < 0) colIdx = 0; if (beamIdx < 0) beamIdx = colIdx;
    let vert = "Y";
    { const t = afterQuotes(tMain[colIdx] || ""); const a = tNodes[+t[0] - 1], b = tNodes[+t[1] - 1];
      if (a && b) { const d = [0, 1, 2].map((i) => Math.abs(a[i] - b[i])); vert = ["X", "Y", "Z"][d.indexOf(Math.max(...d))]; } }
    const toRisa = (n) => (vert === "Z" ? [n.x * k, n.y * k, n.z * k] : [n.x * k, n.z * k, -n.y * k]);
    // node tails: the template's supported node and a free node
    const tBC = lines(block("BOUNDARY_CONDITIONS"));
    const supIdx0 = tBC.length ? +tBC[0].trim().split(/\s+/)[0] - 1 : -1;
    const tailSup = tNodeTail[supIdx0] || "65535 2 0 -1 -1 0", tailFree = tNodeTail.find((t, i) => i !== supIdx0) || "65535 0 0 -1 -1 0";
    const sup = new Set(sm.supports);

    const nodeRecs = sm.nodes.map((n, i) => {
      const [X, Y, Z] = toRisa(n);
      return lab(n.label, W.node) + exp(X) + exp(Y) + exp(Z) + exp(0) + " " + (sup.has(i) ? tailSup : tailFree) + ";";
    });
    const bcProto = tBC[0] || "1 4 4 4 0 0 0 0 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 -1 -1 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0 0;";
    const bcRecs = sm.supports.map((i) => bcProto.trim().replace(/^\d+/, String(i + 1)));

    // member labels: C/G/B numbering, wing prefix when several wings
    const multi = wings.length > 1, cnt = {};
    const mlabel = (m) => {
      const p = { column: "C", girder: "G", beam: "B" }[m.type];
      const key = (multi ? m.wing : "") + p; cnt[key] = (cnt[key] || 0) + 1;
      return (multi && m.wing ? m.wing.replace(/\s*wing\s*/i, "").trim().slice(0, 3).toUpperCase() + "-" : "") + p + cnt[key];
    };
    sm.members.forEach((m) => { m.rlabel = mlabel(m); m.rshape = String(m.shape || o.columnShape).toUpperCase(); });

    // shapes list: keep template records, add AISC-built W records for shapes not there
    const tShapes = lines(block("SHAPES_LIST"));
    const have = new Set(tShapes.map((l) => quoted(l)[0].trim().toUpperCase()));
    const f6 = (v) => (Math.round(v * 1e6) / 1e6).toFixed(6);
    const missing = [];
    const newShapes = [];
    for (const s of [...new Set(sm.members.map((m) => m.rshape))]) {
      if (have.has(s)) continue;
      const r = shapeTable && shapeTable[s];
      if (!r) { missing.push(s); continue; }
      const rT = r.bf / Math.sqrt(12 * (1 + ((r.d - 2 * r.tf) * r.tw) / (6 * r.bf * r.tf)));
      const p = [r.A, r.d, r.tw, r.bf, r.tf, rT, r.Ix, r.Iy, r.Zx, r.Zy, r.J, r.Cw, r.Wno, r.Sw1, r.Qf, r.Qw, r.kdes, r.k1, 0, r.kdet, 0, 0, 0, 7];
      newShapes.push(lab(s, W.shape) + " 5 1 1 " + p.map(f6).join(" ") + ";");
      have.add(s);
    }
    if (missing.length) throw new Error("No AISC data for shape(s): " + missing.join(", "));

    // members: clone the template's column / beam record in every member section
    const sec = (tag) => {
      const ls = lines(block(tag));
      return { tag, ls, col: ls[colIdx] || ls[0], beam: ls[beamIdx] || ls[0] };
    };
    const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); });
    const relabel = (rec, label) => rec.replace(/^"[^"]*"/, lab(label, W.member));
    const memberSecTags = [];
    { const re = /\[(\.MEMBERS_[A-Z_]+)\]\s*<\d+>/g; let m; const mb = block("MEMBERS"); const body = mb ? mb.body : "";
      while ((m = re.exec(body))) memberSecTags.push(m[1]); }
    const memberSections = memberSecTags.map((tag) => {
      const s = sec(tag);
      const recs = sm.members.map((m, idx) => {
        const proto = m.type === "column" ? s.col : s.beam;
        if (!proto) return "";
        if (tag === ".MEMBERS_MAIN_DATA") {
          const q = quoted(proto), t = afterQuotes(proto);
          t[0] = String(m.i + 1); t[1] = String(m.j + 1); t[2] = "0";
          // keep any trailing quoted field(s) after the numbers (e.g. a blank comment)
          const tail = proto.slice(proto.indexOf('"', proto.indexOf('"', proto.indexOf('"', proto.indexOf('"', proto.indexOf('"', proto.indexOf('"') + 1) + 1) + 1) + 1) + 1) + 1);
          const nums = tail.replace(/;\s*$/, "");
          const parts = nums.split('"');
          const head = parts[0].trim().split(/\s+/);
          head[0] = String(m.i + 1); head[1] = String(m.j + 1); head[2] = "0";
          const rest = parts.length > 1 ? ' "' + parts.slice(1).join('"') : "";
          return lab(m.rlabel, W.member) + " " + lab(q[1], W.shape) + " " + lab(m.rshape, W.shape) + " " + head.join(" ") + rest + ";";
        }
        if (tag === ".MEMBERS_SUPPLEMENTARY_DATA") return relabel(proto, m.rlabel).replace(/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i, '"' + uuid() + '"');
        if (proto.trim().startsWith('"')) return relabel(proto, m.rlabel);
        return proto;                       // unlabeled records (e.g. calc-mode) repeat in order
      });
      return { tag, text: "[" + tag + "] <" + sm.members.length + ">\n" + recs.join("\n") + "\n[." + "END_" + tag.slice(1) + "]" };
    });

    // assemble: replace blocks from the end so offsets stay valid
    const reps = [];
    const put = (tag, n, recs) => { const b = block(tag); if (b) reps.push({ start: b.start, end: b.end, text: "[" + tag + "] <" + n + ">\n" + recs.join("\n") + "\n[" + (tag.startsWith(".") ? "." : "") + "END_" + tag.replace(/^\./, "") + "]" }); };
    put("NODES", nodeRecs.length, nodeRecs);
    put("BOUNDARY_CONDITIONS", bcRecs.length, bcRecs);
    put("SHAPES_LIST", tShapes.length + newShapes.length, tShapes.concat(newShapes));
    for (const ms of memberSections) { const b = block(ms.tag); if (b) reps.push({ start: b.start, end: b.end, text: ms.text }); }
    reps.sort((a, b) => b.start - a.start);
    let out = T;
    for (const r of reps) out = out.slice(0, r.start) + r.text + out.slice(r.end);
    return { text: out.replace(/\n/g, "\r\n"), stats: { nodes: sm.nodes.length, members: sm.members.length, supports: sm.supports.length, vertical: vert, unitsPerInch: k, addedShapes: newShapes.length, byType: sm.members.reduce((a, m) => ((a[m.type] = (a[m.type] || 0) + 1), a), {}) } };
  };

  // ------------------------------------------------------------- zip (stored, no compression)
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  E.zip = function (files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
        .forEach(([o, v, s]) => (s === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true)));
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
        .forEach(([o, v, s]) => (s === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true)));
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const csize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, csize, 4], [16, offset, 4], [20, 0, 2]]
      .forEach(([o, v, s]) => (s === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const buf = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let o = 0; for (const p of all) { buf.set(p, o); o += p.length; }
    return buf;
  };

  if (typeof module !== "undefined" && module.exports) module.exports = E;
  else root.ColumnEngine = E;
})(typeof window !== "undefined" ? window : globalThis);
