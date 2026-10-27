// Sketch to RISA: trace a drawing, export nodes and members for RISA-3D.
// Model coordinates are stored in drawing pixels; the scale converts them to feet on export.
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const SNAP_PX = 10;          // screen pixels for snapping to an existing node
const PDF_RENDER_SCALE = 2;  // render PDF pages at 2x for crisp tracing

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");

const model = { nodes: [], members: [], nextNode: 1, nextMember: 1, ftPerPx: null };
const view = { x: 0, y: 0, k: 1 };  // screen = doc * k + (x, y)
let docImage = null;                // canvas holding the rendered drawing
let pdfDoc = null;
let mode = "draw";
let chainFrom = null;               // node id the current member chain starts from
let calibPts = [];
let hover = null;                   // doc-space mouse position
let dragNode = null;
let pan = null;
let spaceDown = false;
let shiftDown = false;
let fade = false;
const history = [];
let suggestions = [];               // detected segments waiting for Accept, in doc pixels
let suggestTol = 6;                 // doc-pixel tolerance the detector used
let detectBox = null;               // box being dragged in Find lines mode
let lastDetectRect = null;

// ---------- geometry helpers ----------
const toDoc = (sx, sy) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });
const toScreen = (p) => ({ x: p.x * view.k + view.x, y: p.y * view.k + view.y });
const nodeById = (id) => model.nodes.find((n) => n.id === id);

function nearestNode(p, maxScreenPx = SNAP_PX) {
  let best = null, bestD = maxScreenPx / view.k;
  for (const n of model.nodes) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= bestD) { best = n; bestD = d; }
  }
  return best;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function nearestMember(p) {
  let best = null, bestD = SNAP_PX / view.k;
  for (const m of model.members) {
    const d = distToSegment(p, nodeById(m.i), nodeById(m.j));
    if (d <= bestD) { best = m; bestD = d; }
  }
  return best;
}

function orthoLock(from, p) {
  return Math.abs(p.x - from.x) >= Math.abs(p.y - from.y)
    ? { x: p.x, y: from.y }
    : { x: from.x, y: p.y };
}

// ---------- length parsing and formatting ----------
// Accepts 24, 24.5, 24', 24'-6", 24' 6 1/2", 6", 2.5m
function parseLengthFt(text) {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.match(/^([\d.]+)\s*m$/);
  if (m) return parseFloat(m[1]) / 0.3048;
  const frac = (str) => str.split(" ").reduce((sum, part) => {
    if (part.includes("/")) { const [a, b] = part.split("/").map(Number); return sum + a / b; }
    return sum + (parseFloat(part) || 0);
  }, 0);
  const ftIn = s.match(/^(?:([\d.]+)\s*')?\s*-?\s*(?:([\d./ ]+)\s*")?$/);
  if (ftIn && (ftIn[1] || ftIn[2])) {
    return (parseFloat(ftIn[1]) || 0) + (ftIn[2] ? frac(ftIn[2].trim()) / 12 : 0);
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function fmtFtIn(ft) {
  const totalIn = Math.round(ft * 12 * 4) / 4;
  const f = Math.floor(totalIn / 12);
  const i = totalIn - f * 12;
  return `${f}'-${i}"`;
}

// ---------- export (the RISA formats live in export.js) ----------
const exportOpts = () => ({ roundIn: Number($("round").value), plane: $("plane").value });
const tableFor = (kind) => RisaExport.table(model, kind, exportOpts());

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- model edits ----------
function snapshot() {
  history.push(JSON.stringify(model));
  if (history.length > 200) history.shift();
}

function addNodeAt(p) {
  const existing = nearestNode(p);
  if (existing) return existing;
  const n = { id: model.nextNode++, x: p.x, y: p.y, support: "" };
  model.nodes.push(n);
  if (p.member) splitMember(p.member, n);
  return n;
}

// a node placed on a member splits it in two, so the members stay connected in RISA
function splitMember(m, n) {
  const j = m.j;
  m.j = n.id;
  model.members.push({ id: model.nextMember++, i: n.id, j });
}

function dedupeMembers() {
  const seen = new Set();
  model.members = model.members.filter((m) => {
    const key = Math.min(m.i, m.j) + "-" + Math.max(m.i, m.j);
    if (m.i === m.j || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// every node lying inside a member splits that member, so T-joints connect
function splitMembersAtNodes(tol) {
  const out = [];
  for (const m of model.members) {
    const a = nodeById(m.i), b = nodeById(m.j);
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
    const tOf = (n) => ((n.x - a.x) * dx + (n.y - a.y) * dy) / L2;
    const on = model.nodes
      .filter((n) => n !== a && n !== b && tOf(n) > 0 && tOf(n) < 1 && distToSegment(n, a, b) <= tol)
      .sort((p, q) => tOf(p) - tOf(q));
    if (!on.length) { out.push(m); continue; }
    const chain = [a, ...on, b];
    out.push({ ...m, j: chain[1].id });
    for (let k = 1; k < chain.length - 1; k++) out.push({ id: model.nextMember++, i: chain[k].id, j: chain[k + 1].id });
  }
  model.members = out;
  dedupeMembers();
}

// ---------- auto-detect ----------
function runDetect(rect) {
  if (!docImage) return status("Open a drawing first.");
  lastDetectRect = rect;
  status("Finding lines...");
  setTimeout(() => {
    const t0 = performance.now();
    const minFrac = Number($("minLen").value) / 100;
    const res = LineDetect.detect(docImage, rect, { minFrac });
    suggestions = res.segments;
    suggestTol = res.tol;
    updateSuggestUI();
    const ms = Math.round(performance.now() - t0);
    status(suggestions.length
      ? `Found ${suggestions.length} lines (${ms} ms). Remove extras with Delete, then Accept.`
      : "No lines found. Try a smaller length limit or a tighter box.");
    draw();
  }, 20);
}

function updateSuggestUI() {
  $("accept").disabled = $("discard").disabled = !suggestions.length;
  $("accept").textContent = suggestions.length ? `Accept ${suggestions.length}` : "Accept";
}

function acceptSuggestions() {
  if (!suggestions.length) return;
  snapshot();
  const tol = suggestTol;
  const findOrAdd = (x, y) => {
    let best = null, bd = tol;
    for (const n of model.nodes) { const d = Math.hypot(n.x - x, n.y - y); if (d <= bd) { best = n; bd = d; } }
    if (best) return best;
    const n = { id: model.nextNode++, x, y, support: "" };
    model.nodes.push(n);
    return n;
  };
  const before = model.members.length;
  for (const g of suggestions) addMember(findOrAdd(g.x1, g.y1), findOrAdd(g.x2, g.y2));
  // lines that cross (a beam through a column) get a node there, so they connect
  const segs = model.members.map((m) => { const a = nodeById(m.i), b = nodeById(m.j); return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }; });
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const P = crossing(segs[i], segs[j]);
      if (P) findOrAdd(P.x, P.y);
    }
  }
  splitMembersAtNodes(tol);
  const added = model.members.length - before;
  suggestions = [];
  updateSuggestUI();
  setMode(model.ftPerPx ? "support" : "calibrate");
  status(`Added ${added} members. ${model.ftPerPx ? "Now set supports." : "Now set the scale."}`);
  refresh();
}

// where two segments cross inside both (not at their ends), or null
function crossing(A, B) {
  const d1x = A.x2 - A.x1, d1y = A.y2 - A.y1, d2x = B.x2 - B.x1, d2y = B.y2 - B.y1;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((B.x1 - A.x1) * d2y - (B.y1 - A.y1) * d2x) / den;
  const u = ((B.x1 - A.x1) * d1y - (B.y1 - A.y1) * d1x) / den;
  const e = 0.001;
  return t > e && t < 1 - e && u > e && u < 1 - e ? { x: A.x1 + t * d1x, y: A.y1 + t * d1y } : null;
}

function nearestSuggestion(p) {
  let best = -1, bestD = SNAP_PX / view.k;
  suggestions.forEach((g, i) => {
    const d = distToSegment(p, { x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 });
    if (d <= bestD) { best = i; bestD = d; }
  });
  return best;
}

function addMember(a, b) {
  if (a.id === b.id) return;
  const dup = model.members.some((m) => (m.i === a.id && m.j === b.id) || (m.i === b.id && m.j === a.id));
  if (!dup) model.members.push({ id: model.nextMember++, i: a.id, j: b.id });
}

function deleteAt(p) {
  const n = nearestNode(p);
  if (n) {
    snapshot();
    model.nodes = model.nodes.filter((x) => x !== n);
    model.members = model.members.filter((m) => m.i !== n.id && m.j !== n.id);
    return true;
  }
  const m = nearestMember(p);
  if (m) {
    snapshot();
    model.members = model.members.filter((x) => x !== m);
    pruneOrphans();
    return true;
  }
  return false;
}

function pruneOrphans() {
  const used = new Set(model.members.flatMap((m) => [m.i, m.j]));
  model.nodes = model.nodes.filter((n) => used.has(n.id) || n.support);
}

const SUPPORT_CYCLE = ["", "Pinned", "Fixed", "Roller"];

// ---------- drawing ----------
function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function fitView() {
  if (!docImage) return;
  const r = canvas.getBoundingClientRect();
  view.k = Math.min(r.width / docImage.width, r.height / docImage.height) * 0.95 || 1;  // 1 if the canvas is hidden
  view.x = (r.width - docImage.width * view.k) / 2;
  view.y = (r.height - docImage.height * view.k) / 2;
  draw();
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (docImage) {
    ctx.save();
    ctx.globalAlpha = fade ? 0.35 : 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(docImage, view.x, view.y, docImage.width * view.k, docImage.height * view.k);
    ctx.restore();
  }

  const cMember = css("--member"), cNode = css("--node"), cSup = css("--support"), cPrev = css("--preview");

  if (suggestions.length) {
    ctx.save();
    ctx.strokeStyle = cPrev; ctx.fillStyle = cPrev; ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    for (const g of suggestions) {
      const a = toScreen({ x: g.x1, y: g.y1 }), b = toScreen({ x: g.x2, y: g.y2 });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillRect(a.x - 3, a.y - 3, 6, 6); ctx.fillRect(b.x - 3, b.y - 3, 6, 6);
    }
    ctx.restore();
  }
  if (detectBox) {
    const a = toScreen(detectBox.a), b = toScreen(detectBox.b);
    ctx.save();
    ctx.strokeStyle = cPrev; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }

  ctx.lineWidth = 3;
  ctx.strokeStyle = cMember;
  ctx.font = "11px system-ui, sans-serif";
  for (const m of model.members) {
    const a = toScreen(nodeById(m.i)), b = toScreen(nodeById(m.j));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.fillStyle = cMember;
    ctx.fillText("M" + m.id, (a.x + b.x) / 2 + 4, (a.y + b.y) / 2 - 4);
  }

  for (const n of model.nodes) {
    const p = toScreen(n);
    if (n.support) drawSupport(p, n.support, cSup);
    ctx.fillStyle = cNode;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillText("N" + n.id, p.x + 6, p.y + 14);
  }

  // live preview of the member being drawn, with its length
  if (mode === "draw" && chainFrom && hover) {
    const from = nodeById(chainFrom);
    const to = previewPoint(hover);
    const a = toScreen(from), b = toScreen(to);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = cPrev; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    if (model.ftPerPx) {
      ctx.fillStyle = cPrev;
      ctx.fillText(fmtFtIn(Math.hypot(to.x - from.x, to.y - from.y) * model.ftPerPx), b.x + 8, b.y - 8);
    }
  }

  if (mode === "calibrate" && calibPts.length) {
    const a = toScreen(calibPts[0]), b = hover ? toScreen(hover) : a;
    ctx.strokeStyle = cPrev; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // snap ring
  if (hover && (mode === "draw" || mode === "support" || mode === "move")) {
    const n = nearestNode(hover);
    if (n) {
      const p = toScreen(n);
      ctx.strokeStyle = cPrev; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

function drawSupport(p, type, color) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
  if (type === "Fixed") {
    ctx.fillRect(p.x - 12, p.y + 4, 24, 4);
    for (let i = -12; i < 12; i += 6) { ctx.beginPath(); ctx.moveTo(p.x + i, p.y + 8); ctx.lineTo(p.x + i - 4, p.y + 13); ctx.stroke(); }
  } else {
    ctx.beginPath(); ctx.moveTo(p.x, p.y + 3); ctx.lineTo(p.x - 9, p.y + 16); ctx.lineTo(p.x + 9, p.y + 16); ctx.closePath(); ctx.stroke();
    if (type === "Roller") {
      ctx.beginPath(); ctx.arc(p.x - 5, p.y + 20, 3, 0, Math.PI * 2); ctx.arc(p.x + 5, p.y + 20, 3, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.restore();
}

// Where a click lands: an existing node, else a point on a nearby member, else the cursor.
// With ortho on, a point on a member is where the locked line crosses it.
function previewPoint(p, shift = shiftDown) {
  const snapped = nearestNode(p);
  if (snapped) return snapped;
  const ortho = chainFrom && (shift || $("ortho").checked);
  const q = ortho ? orthoLock(nodeById(chainFrom), p) : p;
  const m = nearestMember(q);
  if (m) return pointOnMember(m, q, ortho ? nodeById(chainFrom) : null) || q;
  return q;
}

function pointOnMember(m, q, from) {
  const a = nodeById(m.i), b = nodeById(m.j);
  const dx = b.x - a.x, dy = b.y - a.y;
  if (from) {
    // intersect the horizontal or vertical line through q with the member
    if (q.y === from.y && Math.abs(dy) > 1e-9) {
      const t = (q.y - a.y) / dy;
      return t > 0 && t < 1 ? { x: a.x + t * dx, y: q.y, member: m } : null;
    }
    if (q.x === from.x && Math.abs(dx) > 1e-9) {
      const t = (q.x - a.x) / dx;
      return t > 0 && t < 1 ? { x: q.x, y: a.y + t * dy, member: m } : null;
    }
    return null;
  }
  const t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1);
  return t > 0 && t < 1 ? { x: a.x + t * dx, y: a.y + t * dy, member: m } : null;
}

// ---------- UI refresh ----------
function refresh() {
  $("nNodes").textContent = model.nodes.length;
  $("nMembers").textContent = model.members.length;
  $("scaleOut").textContent = model.ftPerPx
    ? `1 ft = ${(1 / model.ftPerPx).toFixed(1)} px`
    : "not set (exports in pixels)";
  const hasModel = model.nodes.length > 0;
  for (const kind of ["nodes", "members"]) {
    const t = $(kind === "nodes" ? "nodeTable" : "memberTable");
    const rows = hasModel ? tableFor(kind) : [];
    t.innerHTML = rows.map((r, i) =>
      "<tr>" + r.map((c) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join("") + "</tr>").join("");
  }
  try { localStorage.setItem("sketch-to-risa", JSON.stringify(model)); } catch (e) { /* storage unavailable */ }
  draw();
}

function setMode(m) {
  mode = m;
  chainFrom = null;
  calibPts = [];
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  const tips = {
    calibrate: "Click both ends of a known dimension.",
    draw: "Click node to node. Shift locks horizontal or vertical. Right-click or Esc ends a chain.",
    support: "Click a node to cycle Pinned, Fixed, Roller, none.",
    move: "Drag a node to adjust it.",
    delete: "Click a node, member or suggested line to remove it.",
    detect: "Drag a box around the framing, or click once for the whole sheet.",
  };
  status(tips[m]);
  draw();
}

function status(text) { $("status").textContent = text; }

// ---------- loading drawings ----------
async function openFile(file) {
  if (!file) return;
  status("Loading " + file.name + "...");
  try {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      pdfDoc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      $("pageCount").textContent = pdfDoc.numPages;
      $("pageNum").max = pdfDoc.numPages;
      $("pageNum").value = 1;
      $("pageCtl").hidden = pdfDoc.numPages < 2;
      await renderPdfPage(1);
    } else {
      pdfDoc = null;
      $("pageCtl").hidden = true;
      const img = await loadImage(file);
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ictx = c.getContext("2d");
      ictx.fillStyle = "#ffffff";
      ictx.fillRect(0, 0, c.width, c.height);
      ictx.drawImage(img, 0, 0);
      docImage = c;
    }
    $("drop").classList.add("hidden");
    fitView();
    setMode(model.ftPerPx ? "draw" : "calibrate");
    if (!model.ftPerPx) status("Loaded. Step 1: click both ends of a known dimension to set the scale.");
  } catch (err) {
    status("Could not open that file: " + err.message);
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("unsupported image format"));
    img.src = URL.createObjectURL(file);
  });
}

async function renderPdfPage(num) {
  const page = await pdfDoc.getPage(num);
  const vp = page.getViewport({ scale: PDF_RENDER_SCALE });
  const c = document.createElement("canvas");
  c.width = vp.width; c.height = vp.height;
  const pctx = c.getContext("2d");
  pctx.fillStyle = "#ffffff";
  pctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: pctx, viewport: vp }).promise;
  docImage = c;
  draw();
}

// ---------- input ----------
function eventPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
  const { sx, sy } = eventPoint(e);
  const p = toDoc(sx, sy);
  canvas.setPointerCapture(e.pointerId);

  if (e.button === 1 || e.button === 2 || spaceDown) {
    pan = { sx, sy, vx: view.x, vy: view.y, moved: false, button: e.button };
    return;
  }
  if (e.button !== 0) return;

  if (mode === "calibrate") {
    calibPts.push(p);
    if (calibPts.length === 2) {
      const px = Math.hypot(calibPts[1].x - calibPts[0].x, calibPts[1].y - calibPts[0].y);
      const answer = prompt("Real length of that line? (for example 24'-6\" or 7.5 for feet)");
      const ft = answer ? parseLengthFt(answer) : NaN;
      if (ft > 0 && px > 0) {
        model.ftPerPx = ft / px;
        refresh();
        setMode("draw");
        status(`Scale set: ${fmtFtIn(ft)} over ${px.toFixed(0)} px. Now draw members.`);
      } else {
        calibPts = [];
        status("Scale not set. Click both ends of a known dimension again.");
      }
    }
    draw();
    return;
  }

  if (mode === "draw") {
    snapshot();
    const target = previewPoint(p, e.shiftKey);
    const node = addNodeAt(target);
    if (chainFrom) addMember(nodeById(chainFrom), node);
    chainFrom = node.id;
    refresh();
    return;
  }

  if (mode === "support") {
    const n = nearestNode(p);
    if (n) {
      snapshot();
      n.support = SUPPORT_CYCLE[(SUPPORT_CYCLE.indexOf(n.support || "") + 1) % SUPPORT_CYCLE.length];
      status(`N${n.id}: ${n.support || "no support"}`);
      refresh();
    }
    return;
  }

  if (mode === "move") {
    const n = nearestNode(p);
    if (n) { snapshot(); dragNode = n; }
    return;
  }

  if (mode === "detect") {
    detectBox = { a: p, b: p };
    return;
  }

  if (mode === "delete") {
    const si = nearestSuggestion(p);
    if (si >= 0) { suggestions.splice(si, 1); updateSuggestUI(); draw(); return; }
    if (deleteAt(p)) refresh();
  }
});

canvas.addEventListener("pointermove", (e) => {
  const { sx, sy } = eventPoint(e);
  shiftDown = e.shiftKey;
  if (pan) {
    if (Math.abs(sx - pan.sx) + Math.abs(sy - pan.sy) > 3) pan.moved = true;
    view.x = pan.vx + (sx - pan.sx);
    view.y = pan.vy + (sy - pan.sy);
  }
  hover = toDoc(sx, sy);
  if (dragNode) { dragNode.x = hover.x; dragNode.y = hover.y; }
  if (detectBox) detectBox.b = hover;
  draw();
});

canvas.addEventListener("pointerup", (e) => {
  if (pan) {
    // a right-click without dragging ends the current member chain
    if (!pan.moved && pan.button === 2) { chainFrom = null; draw(); }
    pan = null;
  }
  if (dragNode) { mergeIfOverlapping(dragNode); dragNode = null; refresh(); }
  if (detectBox) {
    const { a, b } = detectBox;
    detectBox = null;
    const W = docImage ? docImage.width : 0, H = docImage ? docImage.height : 0;
    const x0 = Math.max(0, Math.min(a.x, b.x)), y0 = Math.max(0, Math.min(a.y, b.y));
    const x1 = Math.min(W, Math.max(a.x, b.x)), y1 = Math.min(H, Math.max(a.y, b.y));
    const tiny = (x1 - x0) * view.k < 12 || (y1 - y0) * view.k < 12;
    runDetect(tiny ? { x: 0, y: 0, w: W, h: H } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
});

canvas.addEventListener("pointerleave", () => { hover = null; draw(); });

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const { sx, sy } = eventPoint(e);
  const before = toDoc(sx, sy);
  const k = Math.min(40, Math.max(0.05, view.k * Math.exp(-e.deltaY * 0.0015)));
  view.k = k;
  view.x = sx - before.x * k;
  view.y = sy - before.y * k;
  draw();
}, { passive: false });

// dropping a moved node onto another one merges them
function mergeIfOverlapping(n) {
  const other = model.nodes.find((o) => o !== n && Math.hypot(o.x - n.x, o.y - n.y) <= SNAP_PX / view.k);
  if (!other) return;
  for (const m of model.members) {
    if (m.i === n.id) m.i = other.id;
    if (m.j === n.id) m.j = other.id;
  }
  dedupeMembers();
  other.support = other.support || n.support;
  model.nodes = model.nodes.filter((x) => x !== n);
}

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  shiftDown = e.shiftKey;
  if (e.key === " ") { spaceDown = true; e.preventDefault(); }
  if (e.key === "Escape") { chainFrom = null; calibPts = []; detectBox = null; draw(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  const keys = { c: "calibrate", d: "draw", s: "support", m: "move", x: "delete", f: "detect" };
  if (!e.ctrlKey && !e.metaKey && keys[e.key.toLowerCase()]) setMode(keys[e.key.toLowerCase()]);
  if (e.key === "Delete" || e.key === "Backspace") setMode("delete");
});
window.addEventListener("keyup", (e) => {
  shiftDown = e.shiftKey;
  if (e.key === " ") spaceDown = false;
});

function undo() {
  const prev = history.pop();
  if (!prev) return;
  Object.assign(model, JSON.parse(prev));
  chainFrom = null;
  refresh();
}

// ---------- buttons ----------
document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("file").addEventListener("change", (e) => openFile(e.target.files[0]));
$("pageNum").addEventListener("change", (e) => {
  const n = Math.min(pdfDoc.numPages, Math.max(1, Number(e.target.value) || 1));
  renderPdfPage(n);
});
$("undo").addEventListener("click", undo);
$("clear").addEventListener("click", () => {
  if (!model.nodes.length || !confirm("Clear all nodes and members? The scale is kept.")) return;
  snapshot();
  Object.assign(model, { nodes: [], members: [], nextNode: 1, nextMember: 1 });
  chainFrom = null;
  refresh();
});
$("fit").addEventListener("click", fitView);
$("dim").addEventListener("click", () => { fade = !fade; draw(); });
$("accept").addEventListener("click", acceptSuggestions);
$("discard").addEventListener("click", () => { suggestions = []; updateSuggestUI(); status("Suggestions discarded."); draw(); });
$("minLen").addEventListener("input", (e) => { $("minLenOut").textContent = e.target.value + "%"; });
$("minLen").addEventListener("change", () => { if (lastDetectRect && suggestions.length) runDetect(lastDetectRect); });
$("plane").addEventListener("change", refresh);
$("round").addEventListener("change", refresh);

document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  if (!model.nodes.length) return status("Nothing to copy yet.");
  const rows = tableFor(b.dataset.copy).slice(1);  // RISA spreadsheets take data rows only
  try {
    await navigator.clipboard.writeText(RisaExport.tsv(rows));
    status(`Copied ${rows.length} ${b.dataset.copy} rows. Paste into the matching RISA-3D spreadsheet.`);
  } catch (err) {
    status("Clipboard blocked by the browser. Use Download CSV instead.");
  }
}));

$("dxf").addEventListener("click", () => {
  if (!model.members.length) return status("Draw at least one member first.");
  download("model.dxf", RisaExport.dxf(model, exportOpts()), "application/dxf");
  status("DXF downloaded. Units are feet. In RISA-3D: File > Import > DXF.");
});

$("csv").addEventListener("click", () => {
  if (!model.nodes.length) return status("Nothing to export yet.");
  download("model.csv", RisaExport.csv(model, exportOpts()), "text/csv");
});

$("saveJson").addEventListener("click", () => download("sketch-to-risa.json", JSON.stringify(model, null, 2), "application/json"));
$("loadJson").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    snapshot();
    Object.assign(model, JSON.parse(await f.text()));
    refresh();
    status("Project loaded.");
  } catch (err) { status("That file is not a saved project."); }
});

// drag and drop onto the drawing area
const stage = document.querySelector(".stage");
stage.addEventListener("dragover", (e) => e.preventDefault());
stage.addEventListener("drop", (e) => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });

// ---------- start ----------
try {
  const saved = JSON.parse(localStorage.getItem("sketch-to-risa") || "null");
  if (saved && Array.isArray(saved.nodes)) Object.assign(model, saved);
} catch (e) { /* storage unavailable */ }
window.addEventListener("resize", resize);
resize();
refresh();
setMode("draw");
status(model.nodes.length ? "Restored your last model. Open the drawing again to keep tracing." : "Open a PDF or image to start.");

// Opened from a Model Generator project (?project=<id>): load that project's plan sheet.
(async () => {
  const pid = new URLSearchParams(location.search).get("project");
  if (!pid || !window.MGStore) return;
  const proj = MGStore.get(pid), file = await MGStore.getFile(pid);
  if (!file) return status("That project has no plan sheet saved in this browser.");
  await openFile(file);
  if (pdfDoc && proj && proj.page > 1 && proj.page <= pdfDoc.numPages) {
    $("pageNum").value = proj.page;
    await renderPdfPage(proj.page);
  }
})();
