// Finds straight members in a drawing or a photo of a sketch.
// Pipeline: adaptive threshold -> thinning to 1 px strokes -> Hough transform with
// segment extraction -> cleanup (merge broken pieces, square up, join ends at corners and T's).
// Plain JavaScript, no libraries. Methods are textbook: Bradley and Roth adaptive threshold (2007),
// Zhang and Suen thinning (1984), Hough transform (Duda and Hart, 1972).
"use strict";

window.LineDetect = (() => {
  const WORK_MAX = 1400;  // longest side of the working image, in pixels

  // source: a canvas; rect: {x, y, w, h} in source pixels; opts.minFrac: shortest line as a fraction of the box
  function detect(source, rect, opts = {}) {
    const minFrac = opts.minFrac ?? 0.08;
    const s = Math.min(1, WORK_MAX / Math.max(rect.w, rect.h));
    const W = Math.max(8, Math.round(rect.w * s)), H = Math.max(8, Math.round(rect.h * s));
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, W, H);
    cx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, W, H);
    const { data } = cx.getImageData(0, 0, W, H);

    const gray = new Float32Array(W * H);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    }
    const ink = adaptiveThreshold(gray, W, H);
    thin(ink, W, H);

    const size = Math.max(W, H);
    const minLen = Math.max(12, minFrac * size);
    const tol = Math.max(4, 0.012 * size);
    let segs = hough(ink, W, H, minLen);
    segs = cleanup(segs, tol);
    return {
      segments: segs.map((g) => ({ x1: g.x1 / s + rect.x, y1: g.y1 / s + rect.y, x2: g.x2 / s + rect.x, y2: g.y2 / s + rect.y })),
      tol: tol / s,
    };
  }

  // Ink is anything clearly darker than its neighborhood, which copes with uneven photo lighting.
  function adaptiveThreshold(gray, W, H) {
    const r = Math.max(7, Math.round(Math.max(W, H) / 60));
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        row += gray[y * W + x];
        I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
      }
    }
    const out = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let x = 1; x < W - 1; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const g = gray[y * W + x];
        out[y * W + x] = g < mean * 0.85 && g < 215 ? 1 : 0;
      }
    }
    return out;
  }

  // Zhang-Suen thinning: strokes of any width become 1 px center lines.
  function thin(img, W, H) {
    const del = [];
    for (let iter = 0; iter < 40; iter++) {
      let changed = false;
      for (let step = 0; step < 2; step++) {
        del.length = 0;
        for (let y = 1; y < H - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            if (!img[i]) continue;
            const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
            const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
            const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
                      (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
            if (A !== 1) continue;
            if (step === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
            del.push(i);
          }
        }
        for (const i of del) img[i] = 0;
        if (del.length) changed = true;
      }
      if (!changed) break;
    }
  }

  // Take the strongest Hough line, split the ink along it into continuous runs,
  // keep runs long and dense enough, remove their votes, repeat.
  function hough(img, W, H, minLen) {
    const NT = 180, diag = Math.ceil(Math.hypot(W, H)), NR = 2 * diag + 1;
    const cos = new Float32Array(NT), sin = new Float32Array(NT);
    for (let t = 0; t < NT; t++) { cos[t] = Math.cos((t * Math.PI) / NT); sin[t] = Math.sin((t * Math.PI) / NT); }

    const xs = [], ys = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (img[y * W + x]) { xs.push(x); ys.push(y); }
    const n = xs.length;
    if (!n || n > 300000) return [];

    const acc = new Int32Array(NT * NR);
    const vote = (k, d) => {
      for (let t = 0; t < NT; t++) acc[t * NR + Math.round(xs[k] * cos[t] + ys[k] * sin[t]) + diag] += d;
    };
    for (let k = 0; k < n; k++) vote(k, 1);

    const used = new Uint8Array(n);
    const minVotes = Math.max(10, minLen * 0.5);
    const gap = Math.max(5, minLen * 0.15);
    const band = Math.max(2, 0.003 * Math.max(W, H));  // hand-drawn lines wander a few pixels
    const segs = [];

    for (let guard = 0; guard < 400; guard++) {
      let best = -1, bv = 0;
      for (let i = 0; i < acc.length; i++) if (acc[i] > bv) { bv = acc[i]; best = i; }
      if (bv < minVotes) break;
      const t = Math.floor(best / NR), r = (best % NR) - diag;
      const c = cos[t], s = sin[t];

      const strip = [];
      for (let k = 0; k < n; k++) if (!used[k] && Math.abs(xs[k] * c + ys[k] * s - r) <= band) strip.push(k);
      const u = (k) => -xs[k] * s + ys[k] * c;
      strip.sort((a, b) => u(a) - u(b));

      let found = false, start = 0;
      for (let i = 1; i <= strip.length; i++) {
        if (i < strip.length && u(strip[i]) - u(strip[i - 1]) <= gap) continue;
        const run = strip.slice(start, i);
        const span = run.length ? u(run[run.length - 1]) - u(run[0]) : 0;
        if (span >= minLen && run.length >= span * 0.5) {
          segs.push(fitSegment(xs, ys, run));
          for (const k of run) { used[k] = 1; vote(k, -1); }
          found = true;
        }
        start = i;
      }
      if (!found) {
        // nothing usable on this line: silence the peak and its neighbors
        for (let dt = -1; dt <= 1; dt++) for (let dr = -1; dr <= 1; dr++) {
          const tt = (t + dt + NT) % NT, rr = (best % NR) + dr;
          if (rr >= 0 && rr < NR) acc[tt * NR + rr] = 0;
        }
      }
    }
    return segs;
  }

  // least-squares line through the run's points, trimmed to its extreme points
  function fitSegment(xs, ys, run) {
    let mx = 0, my = 0;
    for (const k of run) { mx += xs[k]; my += ys[k]; }
    mx /= run.length; my /= run.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const k of run) {
      const dx = xs[k] - mx, dy = ys[k] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let lo = Infinity, hi = -Infinity;
    for (const k of run) {
      const p = (xs[k] - mx) * dx + (ys[k] - my) * dy;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    return { x1: mx + lo * dx, y1: my + lo * dy, x2: mx + hi * dx, y2: my + hi * dy };
  }

  // ---------- cleanup ----------
  const len = (g) => Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
  const angleOf = (g) => { let a = Math.atan2(g.y2 - g.y1, g.x2 - g.x1); if (a < 0) a += Math.PI; return a >= Math.PI ? a - Math.PI : a; };
  const angleDiff = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };

  function perpDist(px, py, g) {
    const L = len(g) || 1;
    return Math.abs((g.x2 - g.x1) * (g.y1 - py) - (g.x1 - px) * (g.y2 - g.y1)) / L;
  }

  function cleanup(segs, tol) {
    segs = mergeCollinear(segs, tol);
    segs.forEach((g) => squareUp(g));
    segs = mergeCollinear(segs, tol);
    joinEnds(segs, tol);
    clusterEnds(segs, tol);
    return segs.filter((g) => len(g) > tol * 2);
  }

  // pieces of one wobbly or broken line become one segment
  function mergeCollinear(segs, tol) {
    segs = segs.slice().sort((a, b) => len(b) - len(a));
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const A = segs[i], B = segs[j];
          if (angleDiff(angleOf(A), angleOf(B)) > (5 * Math.PI) / 180) continue;
          if (perpDist(B.x1, B.y1, A) > tol || perpDist(B.x2, B.y2, A) > tol) continue;
          const L = len(A), dx = (A.x2 - A.x1) / L, dy = (A.y2 - A.y1) / L;
          const t = (x, y) => (x - A.x1) * dx + (y - A.y1) * dy;
          const tb1 = t(B.x1, B.y1), tb2 = t(B.x2, B.y2);
          const bLo = Math.min(tb1, tb2), bHi = Math.max(tb1, tb2);
          if (bLo > L + tol * 3 || bHi < -tol * 3) continue;
          const lo = Math.min(0, bLo), hi = Math.max(L, bHi);
          segs[i] = { x1: A.x1 + lo * dx, y1: A.y1 + lo * dy, x2: A.x1 + hi * dx, y2: A.y1 + hi * dy };
          segs.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
    return segs;
  }

  // lines within 3 degrees of horizontal or vertical become exactly so
  function squareUp(g) {
    const a = angleOf(g), lim = (3 * Math.PI) / 180;
    if (a < lim || a > Math.PI - lim) { const y = (g.y1 + g.y2) / 2; g.y1 = g.y2 = y; }
    else if (Math.abs(a - Math.PI / 2) < lim) { const x = (g.x1 + g.x2) / 2; g.x1 = g.x2 = x; }
  }

  // an end that stops short of, or runs past, another line moves to the intersection
  function joinEnds(segs, tol) {
    for (const A of segs) {
      for (const end of [1, 2]) {
        const ex = A["x" + end], ey = A["y" + end];
        let best = null, bestD = tol * 1.5;
        for (const B of segs) {
          if (B === A) continue;
          const P = intersect(A, B);
          if (!P) continue;
          const d = Math.hypot(P.x - ex, P.y - ey);
          if (d >= bestD) continue;
          const LB = len(B);
          const tB = ((P.x - B.x1) * (B.x2 - B.x1) + (P.y - B.y1) * (B.y2 - B.y1)) / (LB * LB);
          if (tB < -tol / LB || tB > 1 + tol / LB) continue;
          best = P; bestD = d;
        }
        if (best) { A["x" + end] = best.x; A["y" + end] = best.y; }
      }
    }
  }

  function intersect(A, B) {
    const d1x = A.x2 - A.x1, d1y = A.y2 - A.y1, d2x = B.x2 - B.x1, d2y = B.y2 - B.y1;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-9 * len(A) * len(B)) return null;
    if (angleDiff(angleOf(A), angleOf(B)) < (10 * Math.PI) / 180) return null;
    const t = ((B.x1 - A.x1) * d2y - (B.y1 - A.y1) * d2x) / den;
    return { x: A.x1 + t * d1x, y: A.y1 + t * d1y };
  }

  // ends that nearly meet become one point
  function clusterEnds(segs, tol) {
    const pts = [];
    segs.forEach((g) => { pts.push([g, 1]); pts.push([g, 2]); });
    const used = new Array(pts.length).fill(false);
    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      const [gi, ei] = pts[i];
      const group = [i];
      for (let j = i + 1; j < pts.length; j++) {
        if (used[j]) continue;
        const [gj, ej] = pts[j];
        if (Math.hypot(gi["x" + ei] - gj["x" + ej], gi["y" + ei] - gj["y" + ej]) <= tol) group.push(j);
      }
      if (group.length < 2) continue;
      let x = 0, y = 0;
      for (const k of group) { used[k] = true; const [g, e] = pts[k]; x += g["x" + e]; y += g["y" + e]; }
      x /= group.length; y /= group.length;
      for (const k of group) { const [g, e] = pts[k]; g["x" + e] = x; g["y" + e] = y; }
    }
  }

  return { detect };
})();
