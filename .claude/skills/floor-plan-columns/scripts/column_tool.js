#!/usr/bin/env node
/* Build the column layout, roof framing, the DXF and the "Column" web app.
 *
 *   node column_tool.js results/model.json [more wing models...] --out results --story-height 14
 *        [--max-spacing 40] [--max-shift 3] [--clearance 6] [--dia 6] [--no-fill]
 *        [--no-framing] [--girder-dir auto|x|y] [--beam-min 8] [--beam-max 12] [--no-column-beams]
 *        [--no-optimize] [--no-flip] [--dead 20] [--live 20] [--name Project]
 *        [--r3d template.r3d] [--column-shape W10X33] [--dxf] [--no-r3d]
 *
 * One model per grid system ("wing"). A building whose wings sit at different angles is
 * read wing by wing (find_columns.py --rotate / --region-poly / --wing) and combined here:
 * each wing is laid out and framed on its own grid, and the DXF places every wing at its
 * true angle and position.
 *
 * Drawn columns are kept as drawn; every grid point the rules call for that has no drawn
 * column gets a proposed column on straight column lines (--no-fill: drawn columns only).
 * Roof framing: girders span the short direction between columns, beams span between
 * girders at an even spacing within --beam-min..--beam-max ft, plus beams on the column
 * lines. All at top of steel = story height in the 3D DXF.
 * Writes: <name>-columns.r3d (RISA-3D, from the user's template in assets/risa_template.r3d
 * or --r3d), layout.json, Column.html (self-contained app); <name>-columns.dxf with --dxf
 * (or when no RISA template is available).
 */
const fs = require("fs"), path = require("path");
const E = require(path.join(__dirname, "..", "assets", "column_engine.js"));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const optVals = new Set(["--r3d", "--column-shape", "--out", "--max-spacing", "--max-shift", "--clearance", "--dia", "--story-height", "--height",
  "--girder-dir", "--beam-min", "--beam-max", "--dead", "--live", "--name"].flatMap((k) => { const i = argv.indexOf(k); return i >= 0 ? [argv[i + 1]] : []; }));
const modelPaths = argv.filter((a) => a.endsWith(".json") && !optVals.has(a));
if (!modelPaths.length) { console.error("usage: node column_tool.js model.json [model2.json ...] --out dir --story-height 14"); process.exit(1); }
const out = opt("--out", path.dirname(modelPaths[0]));
const sh = opt("--story-height", opt("--height"));

const wings = modelPaths.map((mp) => {
  const model = JSON.parse(fs.readFileSync(mp, "utf8"));
  model._dir = path.dirname(mp);
  const rules = { ...model.rules };
  if (opt("--max-spacing")) rules.maxSpacingFt = +opt("--max-spacing");
  if (opt("--max-shift")) rules.maxShiftFt = +opt("--max-shift");
  if (opt("--clearance")) rules.clearanceIn = +opt("--clearance");
  const column = { ...model.column };
  if (opt("--dia")) column.diaIn = +opt("--dia");
  if (sh) column.heightFt = +sh;
  model.rules = rules; model.column = column;
  const framing = { ...E.FRAMING_DEFAULTS, ...(model.framing || {}) };
  if (argv.includes("--no-framing")) framing.on = false;
  if (opt("--girder-dir")) framing.dir = opt("--girder-dir");
  if (opt("--beam-min")) framing.beamMinFt = +opt("--beam-min");
  if (opt("--beam-max")) framing.beamMaxFt = +opt("--beam-max");
  if (argv.includes("--no-column-beams")) framing.beamsAtColumns = false;
  if (argv.includes("--no-optimize")) framing.optimize = false;
  if (argv.includes("--no-flip") || opt("--girder-dir")) framing.allowFlip = false;
  model.framing = framing;
  model.roof = { ...E.ROOF_DEFAULTS, ...(model.roof || {}) };
  if (opt("--dead")) model.roof.deadPsf = +opt("--dead");
  if (opt("--live")) model.roof.livePsf = +opt("--live");
  const drawn = model.columns.filter((c) => c.status === "existing");
  const propose = drawn.length === 0 || !argv.includes("--no-fill");
  model.mode = propose ? (drawn.length ? "fill" : "layout") : "found";
  model.columns = propose ? E.layout(model, rules, column) : E.number(model, drawn);
  return model;
});
if (!sh) console.log(`WARNING: no --story-height given; using ${wings[0].column.heightFt} ft. Ask the user for the story height before delivering the 3D DXF.`);
const multi = wings.length > 1;

const projName = opt("--name", wings[0].project.name || "plan");
const base = projName.replace(/[^\w.-]+/g, "_") + "-columns";
// RISA-3D (.r3d) from the user's template (default: assets/risa_template.r3d); DXF only on request
const assets = path.join(__dirname, "..", "assets");
const r3dArg = argv.includes("--r3d") ? opt("--r3d") : null;
const tplPath = r3dArg && !r3dArg.startsWith("--") ? r3dArg : path.join(assets, "risa_template.r3d");
const colShape = (opt("--column-shape") || (wings[0].column && wings[0].column.shape) || "W10X33").toUpperCase();
wings.forEach((m) => (m.column.shape = colShape));
const shapeCsv = fs.readFileSync(path.join(assets, "aisc_w_shapes.csv"), "utf8");
const writeR3d = fs.existsSync(tplPath) && !argv.includes("--no-r3d");
const outputs = [];
if (writeR3d) {
  const r = E.toR3D(wings.map((m) => ({ model: m, cols: m.columns, column: m.column })), fs.readFileSync(tplPath, "utf8"), E.parseShapeTable(shapeCsv), { columnShape: colShape });
  fs.writeFileSync(path.join(out, base + ".r3d"), r.text);
  outputs.push(base + ".r3d");
  console.log(`RISA-3D: ${r.stats.nodes} nodes, ${r.stats.supports} pinned supports, ${r.stats.members} members (${Object.entries(r.stats.byType).map(([k, v]) => v + " " + k + "s").join(", ")}), vertical axis ${r.stats.vertical}, columns ${colShape}, ${r.stats.addedShapes} W-shapes added from AISC (template: ${path.basename(tplPath)})`);
}
if (!writeR3d || argv.includes("--dxf")) {
  fs.writeFileSync(path.join(out, base + ".dxf"), E.toDXFWings(wings.map((m) => ({ model: m, cols: m.columns, column: m.column }))));
  outputs.push(base + ".dxf");
}

// report + layout.json
const report = [];
let totalLbs = 0, totalArea = 0;
for (const model of wings) {
  const { rules, column, framing } = model;
  const title = multi ? `=== ${model.wing || "Wing"} (grid rotated ${(model.frame || {}).angleDeg || 0} deg) ===` : "";
  if (title) console.log(title);
  const rows = model.columns.map((c) => { const p = E.absolute(model, c); return { ...c, x: p.x, y: p.y, grid: E.gridLabel(model, p.x, p.y) }; });
  const n = (s) => model.columns.filter((c) => (c.status === "proposed" ? c.placement : c.status) === s).length;
  console.log(`Mode: ${model.mode} | columns ${model.columns.length} (drawn ${n("existing")}, in wall ${n("wall")}, exposed ${n("exposed")}, BLOCKING AN OPENING ${n("blocked")}, manual ${n("manual")})`);
  if (model.outsideTargets && model.outsideTargets.length) console.log(`Grid points outside the building (no column): ${model.outsideTargets.join(", ")}`);
  if (model.mergedLines && model.mergedLines.length) console.log(`Grid lines too close to be separate column lines: ${model.mergedLines.join("; ")}`);
  if (model.lineOffsets) {
    const lab = (l) => { const g = E.refLine(E.lines(model, l.axis), l.pos); return Math.abs(g.pos - l.pos) < 1 ? g.label : E.gridLabel(model, l.axis === "x" ? l.pos : 0, l.axis === "y" ? l.pos : 0).split("-")[l.axis === "x" ? 0 : 1] || E.ftin(l.pos); };
    const fmt = (l) => `${lab(l)}: ${l.off ? E.ftin(Math.abs(l.off)) + (l.axis === "x" ? (l.off > 0 ? " right" : " left") : (l.off > 0 ? " up" : " down")) : "on line"}${l.fixed ? " (set by drawn column)" : ""}`;
    console.log("Column lines (one offset per line, all columns on it aligned):");
    console.log("  vertical   " + model.lineOffsets.filter((l) => l.axis === "x").sort((a, b) => a.pos - b.pos).map(fmt).join(" | "));
    console.log("  horizontal " + model.lineOffsets.filter((l) => l.axis === "y").sort((a, b) => b.pos - a.pos).map(fmt).join(" | "));
  }
  console.log(`Rules: max spacing ${rules.maxSpacingFt} ft, max shift ${rules.maxShiftFt} ft, clearance ${rules.clearanceIn} in | column ${column.diaIn}" dia x ${column.heightFt} ft`);
  for (const r of rows) console.log(`  ${r.id.padEnd(4)} ${r.grid.padEnd(9)} ${(r.status === "proposed" ? r.placement : r.status).padEnd(8)} ${E.ftin(r.dx).padStart(9)} from ${r.refX}, ${E.ftin(r.dy).padStart(9)} from ${r.refY}  ${r.note || ""}`);
  const fr = E.resolveFraming(model, model.columns);
  const optInfo = fr.optimization ? { note: fr.optimization.note, options: fr.optimization.results.map((r) => ({ dir: r.dir, lbs: Math.round(r.steel.lbs), psf: +r.steel.psf.toFixed(2), perBay: r.perBay.map((b) => ({ width: b.width, options: b.tried.map((t) => ({ spaces: t.n, lbs: Math.round(t.lbs) })) })) })) } : null;
  delete fr.optimization;
  if (framing.on) {
    console.log(`Roof framing at +${E.ftin(column.heightFt * 12)}: girders run ${fr.dir === "x" ? "left-right" : "up-down"} in this grid, ${fr.girders.length} girders, ${fr.beams.length} beams`);
    const st = fr.steel;
    if (st) { totalLbs += st.lbs; totalArea += st.area; console.log(`  Steel: ${Math.round(st.lbs).toLocaleString("en-US")} lb over ${Math.round(st.area).toLocaleString("en-US")} sf = ${st.psf.toFixed(2)} psf (DL ${model.roof.deadPsf} + LL ${model.roof.livePsf} psf)${st.failed ? `  <-- ${st.failed} members exceed the largest shape` : ""}`); }
    if (optInfo) {
      for (const o of optInfo.options) console.log(`  option: girders ${o.dir === "x" ? "left-right" : "up-down"} ${o.lbs.toLocaleString("en-US")} lb (${o.psf} psf)`);
      if (optInfo.note) console.log("  " + optInfo.note);
    }
    const badBays = fr.bays.filter((b) => !b.ok).length;
    console.log(`  ${fr.bays.length} bays, beam spacing ${[...new Set(fr.bays.map((b) => E.ftin(b.spacing)))].slice(0, 6).join(", ")}${fr.bays.length > 6 ? "..." : ""}${badBays ? `  <-- ${badBays} outside ${framing.beamMinFt}-${framing.beamMaxFt} ft` : ""}`);
    const tally = (ms) => Object.entries(ms.reduce((t, m) => ((t[m.size] = (t[m.size] || 0) + 1), t), {})).map(([k, v]) => v + " x " + k).join(", ");
    console.log(`  Girders: ${tally(fr.girders)} | Beams: ${tally(fr.beams)}`);
    for (const w of fr.warnings) console.log("  WARNING: " + w);
  }
  report.push({ wing: model.wing || "", frame: model.frame || null, mode: model.mode, rules, column, roof: model.roof, lineOffsets: model.lineOffsets, columns: rows, framing: { settings: framing, ...fr, optimization: optInfo } });
}
if (multi && totalArea) console.log(`=== Building: ${wings.length} wings, ${wings.reduce((s, m) => s + m.columns.length, 0)} columns, steel ${Math.round(totalLbs).toLocaleString("en-US")} lb = ${(totalLbs / totalArea).toFixed(2)} psf`);
fs.writeFileSync(path.join(out, "layout.json"), JSON.stringify(multi ? { wings: report } : report[0], null, 1));

// self-contained app: engine + wing models (each with its underlay image embedded)
const tpl = fs.readFileSync(path.join(__dirname, "..", "assets", "column_app.html"), "utf8");
const appWings = wings.map((model) => {
  const m = { ...model, project: { ...model.project, name: projName } };
  delete m._dir;
  if (model.underlay && model.underlay.file) {
    const img = path.join(model._dir, model.underlay.file);
    if (fs.existsSync(img)) m.underlay = { ...model.underlay, src: "data:image/jpeg;base64," + fs.readFileSync(img).toString("base64") };
  }
  return m;
});
const safe = (s) => s.replace(/<\/(script)/gi, "<\\/$1");
const engineSrc = fs.readFileSync(path.join(__dirname, "..", "assets", "column_engine.js"), "utf8");
const risa = writeR3d ? { template: fs.readFileSync(tplPath, "utf8"), shapes: shapeCsv } : null;
const html = tpl
  .replace("/*__ENGINE__*/", () => safe(engineSrc))
  .replace("/*__MODEL__*/", () => safe(JSON.stringify({ wings: appWings, risa })));
fs.writeFileSync(path.join(out, "Column.html"), html);
console.log(`Wrote ${outputs.join(", ")}, layout.json, Column.html in ${out}`);
