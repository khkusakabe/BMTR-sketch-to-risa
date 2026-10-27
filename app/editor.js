// Framing editor: edit the line work found in a sketch photo.
// Geometry is kept in photo pixels; real coordinates (feet) come from the grid
// spacings the user types in, so a sketch that is not to scale still works.
'use strict';

const FramingEditor = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const SIZES = ['W8x10', 'W8x18', 'W10x12', 'W10x22', 'W12x14', 'W12x19', 'W12x26', 'W14x22', 'W14x26',
    'W14x30', 'W16x26', 'W16x31', 'W16x36', 'W18x35', 'W18x40', 'W18x50', 'W21x44', 'W21x50', 'W21x55',
    'W21x62', 'W24x55', 'W24x62', 'W24x76', 'W24x84', 'W27x84', 'W27x94', 'W30x99', 'W30x108'];

  let S;            // state: { w, h, photo, stem, gx, gy, dx, dy, dxSet, dySet, nodes, members, ... }
  let svg, host, onChange;
  let tool = 'select';
  let sel = new Set();
  let pending = null;   // first click of "add member": {x, y}
  let hover = null;     // mouse position for the add-member preview
  let drag = null;      // node being dragged
  let showPhoto = true;
  const undo = [];

  // ---------- geometry helpers ----------
  const diag = () => Math.hypot(S.w, S.h);
  // Joining/snapping distances: fractions of the picture for sketches, real feet for scaled plans.
  const tol = () => S.tol || diag() * 0.012;
  const snapR = () => S.snap || diag() * 0.02;
  const node = id => S.nodes.find(n => n.id === id);
  const clone = o => JSON.parse(JSON.stringify(o));

  function toFt(v, grid, sp) {
    if (grid.length < 2) return v / 20;
    let k = grid.findIndex((g, i) => i < grid.length - 1 && v <= grid[i + 1]);
    if (k < 0) k = grid.length - 2;
    const before = sp.slice(0, k).reduce((a, b) => a + b, 0);
    return before + (v - grid[k]) / (grid[k + 1] - grid[k]) * sp[k];
  }
  const totalY = () => S.dy.reduce((a, b) => a + b, 0);
  const realX = n => toFt(n.x, S.gx, S.dx);
  const realY = n => totalY() - toFt(n.y, S.gy, S.dy);  // plan Y points up
  const lengthFt = m => {
    const a = node(m.i), b = node(m.j);
    return Math.hypot(realX(a) - realX(b), realY(a) - realY(b));
  };

  function segParam(p, a, b) {
    const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2;
    const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.sqrt(L2);
    return { t, d };
  }
  function cross(a, b, c, d) {
    const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
    const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
    return { t, u, x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  }

  function addNode(x, y) {
    const n = { id: S.nextNode++, x, y };
    S.nodes.push(n);
    return n;
  }
  function nodeAt(p) {  // existing node near p, or a new one
    return S.nodes.find(n => Math.hypot(n.x - p.x, n.y - p.y) <= tol()) || addNode(p.x, p.y);
  }
  function split(m, n) {
    S.members.push({ id: S.nextMem++, i: n.id, j: m.j, size: m.size });
    m.j = n.id;
  }

  // Make sure everything that touches is joined: merge close nodes, split members
  // at nodes lying on them and where two members cross.
  function normalize() {
    const T = tol();
    for (const a of S.nodes) for (const b of S.nodes) {
      if (a !== b && !a.dead && !b.dead && Math.hypot(a.x - b.x, a.y - b.y) <= T) {
        b.dead = true;
        a.sup = a.sup || b.sup;
        S.members.forEach(m => { if (m.i === b.id) m.i = a.id; if (m.j === b.id) m.j = a.id; });
      }
    }
    S.nodes = S.nodes.filter(n => !n.dead);
    for (let guard = 0, changed = true; changed && guard < 500; guard++) {
      changed = false;
      outer:
      for (const m of S.members) {
        const a = node(m.i), b = node(m.j);
        for (const n of S.nodes) {
          if (n.id === m.i || n.id === m.j) continue;
          const { t, d } = segParam(n, a, b);
          if (t > 0.001 && t < 0.999 && d <= T) { split(m, n); changed = true; break outer; }
        }
        for (const o of S.members) {
          if (o === m || [o.i, o.j].some(id => id === m.i || id === m.j)) continue;
          const c = cross(a, b, node(o.i), node(o.j));
          if (c && c.t > 0.001 && c.t < 0.999 && c.u > 0.001 && c.u < 0.999) {
            const n = addNode(c.x, c.y);
            split(m, n); split(o, n); changed = true; break outer;
          }
        }
      }
    }
    // drop zero-length and duplicate members
    const seen = new Set();
    S.members = S.members.filter(m => {
      const k = [m.i, m.j].sort((x, y) => x - y).join('-');
      if (m.i === m.j || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const used = new Set(S.members.flatMap(m => [m.i, m.j]));
    S.nodes = S.nodes.filter(n => used.has(n.id));
    sel = new Set([...sel].filter(id => S.members.some(m => m.id === id)));
  }

  function degree() {
    const d = {};
    S.members.forEach(m => { d[m.i] = (d[m.i] || 0) + 1; d[m.j] = (d[m.j] || 0) + 1; });
    return d;
  }
  const looseNodes = () => { const d = degree(); return S.nodes.filter(n => d[n.id] === 1); };

  // Stretch each loose end along its member to the nearest member it would hit.
  function connectLoose() {
    let fixed = 0;
    for (const n of looseNodes()) {
      const m = S.members.find(m => m.i === n.id || m.j === n.id);
      const o = node(m.i === n.id ? m.j : m.i);
      const len = Math.hypot(n.x - o.x, n.y - o.y);
      const far = { x: n.x + (n.x - o.x) / len * diag(), y: n.y + (n.y - o.y) / len * diag() };
      let best = null;
      for (const k of S.members) {
        if (k === m) continue;
        const c = cross(n, far, node(k.i), node(k.j));
        if (c && c.t >= 0 && c.u >= -0.02 && c.u <= 1.02 && (!best || c.t < best.t)) best = c;
      }
      if (best && best.t * diag() <= Math.max(len, diag() * 0.15)) {
        n.x = best.x; n.y = best.y;
        fixed++;
      }
    }
    normalize();
    return fixed;
  }

  // Snap a pointer position to nodes, grid intersections, or grid lines.
  function snap(p, ignore) {
    const R = snapR();
    const n = S.nodes.find(n => n !== ignore && Math.hypot(n.x - p.x, n.y - p.y) <= R);
    if (n) return { x: n.x, y: n.y };
    const near = (v, g) => g.reduce((b, c) => Math.abs(c - v) < Math.abs(b - v) ? c : b, Infinity);
    const sx = near(p.x, S.gx), sy = near(p.y, S.gy);
    return { x: Math.abs(sx - p.x) <= R ? sx : p.x, y: Math.abs(sy - p.y) <= R ? sy : p.y };
  }

  // ---------- grid ----------
  function addGrid(axis, v) {
    const g = axis === 'x' ? S.gx : S.gy, sp = axis === 'x' ? S.dx : S.dy, set = axis === 'x' ? S.dxSet : S.dySet;
    const R = snapR();
    const hit = g.findIndex(c => Math.abs(c - v) <= R);
    if (hit >= 0) {  // clicking an existing grid line removes it (if nothing sits on it)
      if (S.nodes.some(n => Math.abs((axis === 'x' ? n.x : n.y) - g[hit]) < 1)) return 'Grid line has members on it; move or delete them first.';
      if (hit === 0) { sp.splice(0, 1); set.splice(0, 1); }
      else if (hit === g.length - 1) { sp.splice(hit - 1, 1); set.splice(hit - 1, 1); }
      else { sp.splice(hit - 1, 2, sp[hit - 1] + sp[hit]); set.splice(hit - 1, 2, set[hit - 1] && set[hit]); }
      g.splice(hit, 1);
      return null;
    }
    const ftPerPx = g.length > 1 ? sp.reduce((a, b) => a + b, 0) / (g[g.length - 1] - g[0]) : 1 / 20;
    let k = g.findIndex(c => c > v);
    if (k === -1) k = g.length;
    if (k === 0) { sp.unshift(round(g.length ? (g[0] - v) * ftPerPx : 0)); set.unshift(false); }
    else if (k === g.length) { sp.push(round((v - g[k - 1]) * ftPerPx)); set.push(false); }
    else {
      const f = (v - g[k - 1]) / (g[k] - g[k - 1]);
      const a = round(sp[k - 1] * f);
      sp.splice(k - 1, 1, a, round(sp[k - 1] - a)); set.splice(k - 1, 1, false, false);
    }
    g.splice(k, 0, v);
    if (g.length === 1) sp.length = set.length = 0;
    return null;
  }
  const round = v => Math.round(v * 2) / 2;
  const gridName = (axis, k) => axis === 'x' ? String(k + 1) : String.fromCharCode(65 + k);

  // ---------- history ----------
  function push() { undo.push(clone({ ...S, photo: undefined })); if (undo.length > 50) undo.shift(); }
  function doUndo() {
    const prev = undo.pop();
    if (prev) { Object.assign(S, prev); sel.clear(); render(); }
  }
  function edit(fn) { push(); fn(); normalize(); render(); }

  // ---------- rendering ----------
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function render() {
    const M = diag() * 0.09, sw = diag() * 0.0035, fs = diag() * 0.014;
    svg.setAttribute('viewBox', `${-M} ${-M} ${S.w + 1.6 * M} ${S.h + 1.6 * M}`);
    svg.innerHTML = '';
    if (showPhoto) el('image', { href: S.photo, x: 0, y: 0, width: S.w, height: S.h, opacity: 0.35 }, svg);
    else el('rect', { x: 0, y: 0, width: S.w, height: S.h, class: 'fe-paper' }, svg);

    // grid lines, bubbles and editable spacings
    const gl = el('g', { class: 'fe-grid' }, svg);
    S.gx.forEach((x, k) => {
      el('line', { x1: x, y1: -M * 0.55, x2: x, y2: S.h + M * 0.3, 'stroke-width': sw * 0.4 }, gl);
      el('circle', { cx: x, cy: -M * 0.72, r: fs * 0.9, class: 'fe-bubble', 'stroke-width': sw * 0.4 }, gl);
      el('text', { x, y: -M * 0.72, 'font-size': fs, class: 'fe-bubble-t' }, gl).textContent = gridName('x', k);
    });
    S.gy.forEach((y, k) => {
      el('line', { x1: -M * 0.55, y1: y, x2: S.w + M * 0.3, y2: y, 'stroke-width': sw * 0.4 }, gl);
      el('circle', { cx: -M * 0.72, cy: y, r: fs * 0.9, class: 'fe-bubble', 'stroke-width': sw * 0.4 }, gl);
      el('text', { x: -M * 0.72, y, 'font-size': fs, class: 'fe-bubble-t' }, gl).textContent = gridName('y', k);
    });
    const dimBox = (x, y, axis, k) => {
      const w = fs * 4.6, h = fs * 1.9;
      const fo = el('foreignObject', { x: x - w / 2, y: y - h / 2, width: w, height: h }, svg);
      const inp = document.createElement('input');
      const sp = axis === 'x' ? S.dx : S.dy, set = axis === 'x' ? S.dxSet : S.dySet;
      inp.type = 'number'; inp.step = 'any'; inp.min = '0'; inp.value = sp[k];
      inp.className = 'fe-dim' + (set[k] ? '' : ' unset');
      inp.style.fontSize = fs * 0.95 + 'px';
      inp.title = `Spacing ${gridName(axis, k)}–${gridName(axis, k + 1)} in feet` + (set[k] ? '' : ' (not confirmed yet)');
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (v > 0) edit(() => { sp[k] = v; set[k] = true; });
      });
      fo.appendChild(inp);
    };
    for (let k = 0; k < S.gx.length - 1; k++) dimBox((S.gx[k] + S.gx[k + 1]) / 2, -M * 0.3, 'x', k);
    for (let k = 0; k < S.gy.length - 1; k++) dimBox(-M * 0.3, (S.gy[k] + S.gy[k + 1]) / 2, 'y', k);

    // members
    const loose = new Set(looseNodes().map(n => n.id));
    const mg = el('g', {}, svg);
    for (const m of S.members) {
      const a = node(m.i), b = node(m.j);
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': sw,
        class: 'fe-member' + (sel.has(m.id) ? ' sel' : '') + (m.size ? '' : ' nosize') }, mg);
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': sw * 6, class: 'fe-hit', 'data-m': m.id }, mg);
    }
    // member labels: size (or M#) along the member
    for (const m of S.members) {
      const a = node(m.i), b = node(m.j);
      let ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      if (ang > 90) ang -= 180; if (ang <= -90) ang += 180;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const t = el('text', { x: mx, y: my, 'font-size': fs * 0.85, class: 'fe-label' + (m.size ? '' : ' muted'),
        transform: `rotate(${ang} ${mx} ${my}) translate(0 ${-fs * 0.55})`, 'data-m': m.id }, mg);
      t.textContent = (m.size || `M${m.id}`) + `  ${fmtFt(lengthFt(m))}`;
    }
    // supports (columns) as squares, then nodes
    for (const n of S.nodes.filter(n => n.sup)) {
      el('rect', { x: n.x - sw * 3.2, y: n.y - sw * 3.2, width: sw * 6.4, height: sw * 6.4, 'stroke-width': sw * 0.8,
        class: 'fe-support', 'data-n': n.id }, svg);
    }
    for (const n of S.nodes) {
      el('circle', { cx: n.x, cy: n.y, r: sw * (loose.has(n.id) ? 2.6 : 2.4), 'data-n': n.id,
        class: 'fe-node' + (loose.has(n.id) ? ' loose' : '') }, svg);
    }
    // add-member preview
    if (tool === 'member' && pending && hover) {
      const p = snap(hover);
      el('line', { x1: pending.x, y1: pending.y, x2: p.x, y2: p.y, 'stroke-width': sw, class: 'fe-preview' }, svg);
    }
    if (tool === 'member' && hover) {
      const p = snap(hover);
      el('circle', { cx: p.x, cy: p.y, r: sw * 2, class: 'fe-cursor' }, svg);
    }
    onChange && onChange(summary());
  }

  const fmtFt = v => {
    const ft = Math.floor(v + 1e-6), inch = Math.round((v - ft) * 12);
    return inch === 12 ? `${ft + 1}'-0"` : `${ft}'-${inch}"`;
  };

  function summary() {
    const loose = looseNodes().length;
    const unset = S.dxSet.filter(s => !s).length + S.dySet.filter(s => !s).length;
    return {
      members: S.members.map(m => ({ ...m, length: lengthFt(m), lengthTxt: fmtFt(lengthFt(m)) }))
        .sort((a, b) => a.id - b.id),
      nodes: S.nodes.length, supports: S.nodes.filter(n => n.sup).length, loose, unset, nosize: S.members.filter(m => !m.size).length,
      selected: [...sel],
    };
  }

  // Inline size editor on the drawing.
  function inlineSize(m) {
    if (!sel.has(m.id)) { sel = new Set([m.id]); render(); }
    const a = node(m.i), b = node(m.j), fs = diag() * 0.014;
    const w = fs * 8, h = fs * 2.2;
    const fo = el('foreignObject', { x: (a.x + b.x) / 2 - w / 2, y: (a.y + b.y) / 2 - h / 2, width: w, height: h }, svg);
    const inp = document.createElement('input');
    inp.className = 'fe-inline'; inp.style.fontSize = fs + 'px';
    inp.value = m.size || ''; inp.placeholder = 'e.g. W14x22';
    inp.setAttribute('list', 'fe-sizes');
    fo.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const commit = ok => {
      if (done) return; done = true;
      if (ok) setSize(inp.value); else render();
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
      e.stopPropagation();
    });
    inp.addEventListener('blur', () => commit(true));
  }

  function setSize(size, ids = [...sel]) {
    size = size.trim().toUpperCase().replace(/\s+/g, '').replace(/^W(\d+)[X×*](\d)/, 'W$1x$2');
    edit(() => S.members.forEach(m => { if (ids.includes(m.id)) m.size = size; }));
  }

  // ---------- pointer handling ----------
  function pt(e) {
    const p = svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }

  function onDown(e) {
    if (e.target.tagName === 'INPUT') return;
    const p = pt(e);
    if (tool === 'select') {
      const nid = e.target.dataset.n, mid = e.target.dataset.m;
      if (nid) { push(); drag = node(+nid); svg.setPointerCapture(e.pointerId); return; }
      if (mid) {
        const id = +mid;
        if (e.shiftKey || e.ctrlKey) sel.has(id) ? sel.delete(id) : sel.add(id);
        else sel = new Set([id]);
      } else if (!e.shiftKey) sel.clear();
      render();
    } else if (tool === 'member') {
      const q = snap(p);
      if (!pending) { pending = q; render(); return; }
      if (Math.hypot(q.x - pending.x, q.y - pending.y) > tol()) {
        const start = pending;
        edit(() => {
          const a = nodeAt(start), b = nodeAt(q);
          S.members.push({ id: S.nextMem++, i: a.id, j: b.id, size: defaultSize });
        });
      }
      pending = e.shiftKey ? q : null;  // shift: keep drawing a chain
      render();
    } else if (tool === 'support') {
      const n = S.nodes.find(n => Math.hypot(n.x - p.x, n.y - p.y) <= snapR());
      if (n) edit(() => { n.sup = !n.sup; });
    } else if (tool === 'gridx' || tool === 'gridy') {
      push();
      const msg = addGrid(tool === 'gridx' ? 'x' : 'y', tool === 'gridx' ? p.x : p.y);
      if (msg) { undo.pop(); alert(msg); }
      render();
    }
  }
  function onMove(e) {
    const p = pt(e);
    if (drag) { const q = snap(p, drag); drag.x = q.x; drag.y = q.y; render(); return; }
    if (tool === 'member') { hover = p; render(); }
  }
  function onUp() {
    if (drag) { drag = null; normalize(); render(); }
  }
  let defaultSize = '';

  function onKey(e) {
    if (!S || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); deleteSelected(); }
    if (e.key === 'Escape') { pending = null; sel.clear(); render(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
  }

  function deleteSelected() {
    const ids = new Set(sel);
    sel.clear();
    edit(() => { S.members = S.members.filter(m => !ids.has(m.id)); });
  }

  // ---------- public API ----------
  function load(data, container, changed) {
    host = container; onChange = changed;
    const gx = data.grid.x.slice(), gy = data.grid.y.slice();
    const guess = (g) => g.slice(1).map((v, k) => round((v - g[k]) / 20));  // placeholder until typed in
    S = {
      w: data.width, h: data.height, photo: data.photo, stem: data.stem, name: data.name, tol: data.tol, snap: data.snap,
      gx, gy, dx: data.dx ? data.dx.slice() : guess(gx), dy: data.dy ? data.dy.slice() : guess(gy),
      dxSet: gx.slice(1).map(() => !!data.dx), dySet: gy.slice(1).map(() => !!data.dy),
      nodes: data.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, sup: (data.supports || []).includes(n.id) })),
      members: data.members.map(m => ({ id: m.id, i: m.i, j: m.j, size: m.size || '' })),
    };
    S.nextNode = Math.max(0, ...S.nodes.map(n => n.id)) + 1;
    S.nextMem = Math.max(0, ...S.members.map(m => m.id)) + 1;
    undo.length = 0; sel.clear(); pending = null;

    host.innerHTML = '';
    svg = el('svg', { class: 'fe-svg' }, host);
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    // The drawing is rebuilt on every click, so find the member under the pointer here.
    svg.addEventListener('dblclick', e => {
      const mid = document.elementFromPoint(e.clientX, e.clientY)?.dataset?.m;
      const m = mid && S.members.find(m => m.id === +mid);
      if (m && tool === 'select') inlineSize(m);
    });
    svg.addEventListener('pointerleave', () => { hover = null; if (tool === 'member') render(); });
    if (!document.getElementById('fe-sizes')) {
      const dl = document.createElement('datalist');
      dl.id = 'fe-sizes';
      dl.innerHTML = SIZES.map(s => `<option value="${s}">`).join('');
      document.body.appendChild(dl);
    }
    document.removeEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);
    normalize();
    render();
  }

  function setTool(t) { tool = t; pending = null; hover = null; svg.dataset.tool = t; render(); }

  function exportFrame() {
    const ty = totalY();
    const ord = S.nodes.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const nid = new Map(ord.map((n, k) => [n.id, k + 1]));
    return {
      stem: S.stem, source: S.name, units: 'ft',
      grid: {
        x: S.gx.map((_, k) => ({ name: gridName('x', k), at: S.dx.slice(0, k).reduce((a, b) => a + b, 0) })),
        y: S.gy.map((_, k) => ({ name: gridName('y', k), at: ty - S.dy.slice(0, k).reduce((a, b) => a + b, 0) })),
      },
      nodes: ord.map(n => ({ id: nid.get(n.id), x: +realX(n).toFixed(3), y: +realY(n).toFixed(3) })),
      supports: ord.filter(n => n.sup).map(n => nid.get(n.id)),
      members: S.members.slice().sort((a, b) => a.id - b.id).map((m, k) => ({
        id: k + 1, i: nid.get(m.i), j: nid.get(m.j), size: m.size, length: +lengthFt(m).toFixed(3),
      })),
    };
  }

  return {
    load, setTool, undo: doUndo, deleteSelected, connectLoose: () => { push(); const n = connectLoose(); render(); return n; },
    setSize: (size, ids) => setSize(size, ids),
    applySizes: map => edit(() => S.members.forEach(m => { if (map[m.id]) m.size = map[m.id]; })), select: ids => { sel = new Set(ids); render(); },
    selectAll: () => { sel = new Set(S.members.map(m => m.id)); render(); },
    setDefaultSize: s => { defaultSize = s; },
    togglePhoto: on => { showPhoto = on; render(); },
    exportFrame, summary: () => summary(),
    rawState: () => ({ gx: S.gx, gy: S.gy, nodes: S.nodes.map(({ id, x, y, sup }) => ({ id, x, y, sup: !!sup })),
      members: S.members.map(({ i, j, size }) => ({ i, j, size })) }),
  };
})();
