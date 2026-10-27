// Project workspace: shows the plan sheet and the right team tool for the system type.
// 2D Frame and 3D Building run Chandler's generators (Final Models/*.js) in the browser
// and download a RISA-3D .r3d. Truss and misc frames hand off to the matching team tools.
"use strict";

(() => {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const REPO = "https://github.com/khkusakabe/BMTR-sketch-to-risa/tree/main/";
  const LINKS = {
    afshin: REPO + "app",
    philip: REPO + ".claude/skills/floor-plan-columns",
    truss: "https://claude.ai/artifact/EHKFcVRKoUaU1UwbpgMgGr",
    trussBeta: "https://claude.ai/artifact/4N6NXAs1sMhQWdEN2XEZef",
  };

  // Inputs per generator, grouped. type: num | list (comma-separated ft) | W | HSS | base
  const FORMS = {
    frame: {
      script: "Final Models/moment-frame.js",
      intro: "Two-story, one-bay steel moment frame (Chandler's Moment Frame generator). Beam ends are fixed where the sketch marks them fixed, otherwise pinned; base is as selected.",
      groups: [
        ["Geometry", [["bay", "Bay width", "ft"], ["h1", "Base to Level 2", "ft"], ["h2", "Level 2 to roof", "ft"]]],
        ["Sections", [["C1", "Columns", "W", "W"], ["B2", "Level 2 beam", "W", "W"], ["B1", "Roof beam", "W", "W"], ["base", "Base", "", "base"]]],
        ["Beam ends (shaded triangle in the sketch = fixed)", [["B2ends", "Level 2 beam ends", "", "ends"], ["B1ends", "Roof beam ends", "", "ends"]]],
        ["Beam loads (downward)", [["deadB2", "Dead, Level 2", "klf"], ["liveB2", "Live, Level 2", "klf"], ["deadB1", "Dead, roof", "klf"], ["liveB1", "Live, roof", "klf"]]],
        ["Lateral loads at left column (+X)", [["windL2", "Wind, Level 2", "kips"], ["windRoof", "Wind, roof", "kips"], ["eqL2", "Seismic, Level 2", "kips"], ["eqRoof", "Seismic, roof", "kips"]]],
        ["Seismic factors (ASD combinations)", [["rho", "rho", ""], ["SDS", "SDS", ""]]],
      ],
    },
    bldg: {
      script: "Final Models/roof-framing.js",
      intro: "Columns on a grid plus steel roof beams at the column tops (Chandler's Roof Framing generator). Perimeter end bays and interior lines are pinned, perimeter middle bays fixed. Loads by tributary area.",
      groups: [
        ["Grid", [["xSp", "X spacings", "ft, comma-separated", "list"], ["zSp", "Z spacings", "ft, comma-separated", "list"], ["H", "Column height", "ft"]]],
        ["Columns", [["C1", "Corner", "W", "W"], ["C3", "Edge", "W", "W"], ["C2", "Interior", "HSS", "HSS"], ["base", "Base", "", "base"]]],
        ["Roof beams", [["B1", "Perimeter end bays", "W, pinned", "W"], ["B2", "Perimeter middle bays", "W, fixed", "W"], ["B3", "Interior lines", "W, pinned", "W"]]],
        ["Loads", [["D", "Dead", "psf"], ["L", "Live", "psf"], ["WX", "Wind X total", "kips"], ["WZ", "Wind Z total", "kips"], ["Cs", "Seismic coefficient", ""], ["Wsw", "Seismic weight", "kips, blank = D x area"]]],
        ["Seismic factors (ASD combinations)", [["rho", "rho", ""], ["SDS", "SDS", ""]]],
      ],
    },
  };

  const id = new URLSearchParams(location.search).get("id");
  const p = id && MGStore.get(id);
  if (!p) {
    $("title").textContent = "Project not found";
    $("tool").innerHTML = `<p class="note">This project isn't saved in this browser. <a href="new-project.html">Start a new project</a>.</p>`;
    return;
  }

  document.title = "Model Generator · " + p.name;
  $("title").textContent = p.name;
  $("meta").textContent = [p.number, MGStore.systemLabel(p), p.fileName && (p.fileName + (p.page ? " · page " + p.page : ""))].filter(Boolean).join("  ·  ");

  let planSource = null;              // the rendered plan sheet (canvas or img), for the sketch reader
  const planReady = showPlan();
  // 3D Building can switch to columns only (Foundation Plan generator): same inputs minus the roof beams
  const columnsOnly = p.kind === "bldg" && new URLSearchParams(location.search).get("gen") === "columns";
  if (columnsOnly) {
    FORMS.bldg = {
      ...FORMS.bldg,
      script: "Final Models/foundation-plan.js",
      intro: "Columns only on a grid (Chandler's Foundation Plan generator): corner, edge and interior columns, loads by tributary area.",
      groups: FORMS.bldg.groups.filter(([g]) => g !== "Roof beams"),
    };
  }
  if (FORMS[p.kind]) buildGenerator(FORMS[p.kind]); else handOff();

  // ---------- plan sheet ----------
  async function showPlan() {
    const file = await MGStore.getFile(p.id);
    if (!file) return;
    const box = $("sheet");
    try {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        const pg = await pdf.getPage(Math.min(p.page || 1, pdf.numPages));
        const vp = pg.getViewport({ scale: 1.5 });
        const c = document.createElement("canvas");
        c.width = vp.width; c.height = vp.height;
        const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: x, viewport: vp }).promise;
        box.replaceChildren(c);
        planSource = c;
      } else {
        const img = new Image();
        img.src = URL.createObjectURL(file);
        img.alt = "Uploaded plan sheet";
        await img.decode();
        box.replaceChildren(img);
        planSource = img;
      }
    } catch (err) {
      box.innerHTML = `<span class="meta">Could not show this file: ${esc(err.message)}</span>`;
    }
    $("planActions").innerHTML =
      `<a class="btn" href="prototype/?project=${encodeURIComponent(p.id)}">Open in the tracer</a>`;
  }

  // ---------- in-browser generators ----------
  function buildGenerator(spec) {
    const tool = $("tool");
    tool.innerHTML = `<h2>Build the RISA-3D model</h2><p class="note">${esc(spec.intro)}</p><p class="meta">Loading the generator...</p>`;
    const s = document.createElement("script");
    s.src = spec.script;
    s.onerror = () => { tool.innerHTML += `<p class="note">Couldn't load ${esc(spec.script)}.</p>`; };
    s.onload = () => renderForm(spec, RISA);  // each generator declares a global RISA; only one loads per page
    document.head.appendChild(s);
  }

  function renderForm(spec, R) {
    const D = R.DEFAULTS, S = R.shapes();
    const saved = p.inputs || {};
    const val = (k) => (k in saved ? saved[k] : D[k]);
    const opts = (list, v) => list.map((n) => `<option${n === v ? " selected" : ""}>${esc(n)}</option>`).join("");
    const field = ([k, label, unit, type]) => {
      const v = val(k);
      let control;
      if (type === "W") control = `<select name="${k}">${opts(S.Wlist, v)}</select>`;
      else if (type === "HSS") control = `<select name="${k}">${opts(S.HSSlist, v)}</select>`;
      else if (type === "base") control = `<select name="${k}">${opts(["Fixed", "Pinned"], v)}</select>`;
      else if (type === "ends") control = `<select name="${k}">${opts(["fixed", "pinned"], v)}</select>`;
      else if (type === "list") control = `<input name="${k}" value="${esc((v || []).join(", "))}" inputmode="decimal">`;
      else control = `<input name="${k}" value="${v === null || v === undefined ? "" : esc(v)}" inputmode="decimal">`;
      return `<label class="f">${esc(label)}${unit ? ` <span>${esc(unit)}</span>` : ""}${control}</label>`;
    };
    const extra = p.kind === "bldg" && p.stories > 1
      ? `<div class="card note"><b>${p.stories} stories selected.</b> This generator builds one level of columns. For more stories, use Afshin's app below or extend the model in RISA.</div>`
      : "";
    $("tool").innerHTML = `
      <h2>Build the RISA-3D model</h2>
      <p class="note">${esc(spec.intro)}</p>${p.kind === "bldg" ? switcher() : ""}${extra}
      ${p.fileName ? readerCard() : ""}
      <form id="mgForm">
        ${spec.groups.map(([g, fields]) => `<h3>${esc(g)}</h3><div class="grid">${fields.map(field).join("")}</div>`).join("")}
        <h3>RISA template (optional)</h3>
        <label class="f">Your own RISA-saved .r3d <span>keeps your materials, codes and settings</span><input type="file" name="template" accept=".r3d"></label>
        <div class="row">
          <button class="btn primary" type="submit">Download .r3d</button>
          <a class="btn" href="index.html">Back to projects</a>
        </div>
        <div class="ok" id="result" aria-live="polite"></div>
      </form>
      ${moreTools()}`;

    if (p.fileName) wireReader(spec, S);

    $("mgForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target, inputs = {};
      for (const [, fields] of spec.groups) {
        for (const [k, , , type] of fields) {
          const raw = form.elements[k].value.trim();
          if (type === "list") inputs[k] = raw.split(/[,\s]+/).filter(Boolean).map(Number);
          else if (type === "W" || type === "HSS" || type === "base" || type === "ends") inputs[k] = raw;
          else inputs[k] = raw === "" ? null : Number(raw);
        }
      }
      const bad = Object.entries(inputs).filter(([, v]) => (Array.isArray(v) ? v.some((x) => !(x > 0)) : typeof v === "number" && !Number.isFinite(v)));
      if (bad.length) { $("result").textContent = "Check these values: " + bad.map(([k]) => k).join(", "); return; }
      try {
        const tf = form.elements.template.files[0];
        const text = R.build(inputs, tf ? { template: await tf.text() } : {});
        const name = `${p.number} ${p.name}`.replace(/[^\w.-]+/g, "_") + ".r3d";
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text.replace(/\r?\n/g, "\r\n")], { type: "text/plain" }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        const nodes = (text.match(/^\[NODES\]\s*<(\d+)>/m) || [])[1];
        MGStore.update(p.id, { inputs, status: "Exported" });
        $("result").textContent = `Downloaded ${name}${nodes ? ` (${nodes} nodes)` : ""}. Open it in RISA-3D and check geometry, sections, loads and supports.`;
      } catch (err) {
        $("result").textContent = "Couldn't build the model: " + err.message;
      }
    });
  }

  // ---------- read the sketch with Claude ----------
  function readerCard() {
    const has = !!SketchReader.getKey();
    return `<div class="card" id="reader">
      <b>Read the sketch</b>
      <div class="note">Claude reads the members, labels, size table, dimensions, fixed-end triangles and base marks on this sheet and fills in the inputs below. Check every value before you download.</div>
      <div id="keyRow" ${has ? "hidden" : ""} style="margin-top:10px">
        <label class="f">Anthropic API key <span>kept in this browser only; the sheet goes straight from this page to Anthropic</span>
          <input id="apiKey" type="password" autocomplete="off" placeholder="sk-ant-..."></label>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" type="button" id="readBtn">Read the sketch</button>
        <button class="btn" type="button" id="keyBtn" ${has ? "" : "hidden"}>Change API key</button>
      </div>
      <div class="ok" id="readOut" aria-live="polite">${p.reading ? readSummary(p.reading, p.readingWarnings || []) : ""}</div>
    </div>`;
  }

  function readSummary(r, warnings) {
    const li = (xs) => xs.map((x) => `<li>${esc(x)}</li>`).join("");
    const sizes = (r.sections || []).map((s) => `${s.set} = ${s.shape}${s.struck && s.struck.length ? ` (struck: ${s.struck.join(", ")})` : ""}`);
    const fixed = (r.members || []).filter((m) => m.role === "beam").map((m) => `${m.section_set}: ${m.i_end} / ${m.j_end} ends`);
    const sup = (r.supports || []).map((s) => `${s.node} ${s.type}`);
    const flags = [...(r.problems || []), ...warnings];
    return `<div class="note"><b>Read ${(r.nodes || []).length} nodes and ${(r.members || []).length} members</b> (${esc(r.system.replace(/_/g, " "))}).</div>
      <ul class="note" style="margin:6px 0 0;padding-left:20px">
        ${sizes.length ? `<li>Sizes: ${esc(sizes.join("; "))}</li>` : ""}
        ${fixed.length ? `<li>Beam ends: ${esc(fixed.join("; "))}</li>` : ""}
        ${sup.length ? `<li>Supports: ${esc(sup.join(", "))}</li>` : ""}
        ${(r.dimensions_read || []).length ? `<li>Dimensions: ${esc(r.dimensions_read.join(", "))}</li>` : ""}
      </ul>
      ${flags.length ? `<div class="note" style="margin-top:8px;color:#9a3412"><b>Check these</b><ul style="margin:4px 0 0;padding-left:20px">${li(flags)}</ul></div>` : ""}
      ${(r.notes || []).length ? `<div class="note" style="margin-top:8px"><b>Claude's notes</b><ul style="margin:4px 0 0;padding-left:20px">${li(r.notes)}</ul></div>` : ""}`;
  }

  function wireReader(spec, S) {
    const out = $("readOut"), form = $("mgForm");
    $("keyBtn").addEventListener("click", () => { $("keyRow").hidden = false; $("apiKey").focus(); });
    $("readBtn").addEventListener("click", async () => {
      const typed = $("apiKey").value.trim();
      if (typed) SketchReader.setKey(typed);
      if (!SketchReader.getKey()) { $("keyRow").hidden = false; $("apiKey").focus(); out.textContent = "Add your Anthropic API key to read the sketch."; return; }
      await planReady;
      if (!planSource) { out.textContent = "The plan sheet isn't loaded in this browser, so there's nothing to read."; return; }
      const btn = $("readBtn");
      btn.disabled = true;
      out.textContent = "Reading the sketch. This takes about half a minute...";
      try {
        const shapes = new Set([...S.Wlist, ...S.HSSlist]);
        const r = await SketchReader.read(planSource, { hint: MGStore.systemLabel(p), shapes });
        const { inputs, warnings } = p.kind === "frame" ? SketchReader.toMomentFrame(r) : SketchReader.toGrid(r);
        const filled = [];
        for (const [k, v] of Object.entries(inputs)) {
          const el = form.elements[k];
          if (!el) continue;
          if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === v)) { warnings.push(`${k} = ${v} isn't in the shape list; left as ${el.value}.`); continue; }
          el.value = Array.isArray(v) ? v.join(", ") : v;
          filled.push(k);
        }
        $("keyRow").hidden = true; $("keyBtn").hidden = false; $("apiKey").value = "";
        MGStore.update(p.id, { reading: r, readingWarnings: warnings, status: "Read" });
        p.reading = r;
        out.innerHTML = readSummary(r, warnings) + `<div class="note" style="margin-top:8px">Filled ${filled.length} inputs from the sketch. Loads aren't on the sketch, so enter them below.</div>`;
      } catch (err) {
        if (/key was rejected/.test(err.message)) { SketchReader.setKey(""); $("keyRow").hidden = false; $("keyBtn").hidden = true; }
        out.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function switcher() {
    const base = "generate.html?id=" + encodeURIComponent(p.id);
    return columnsOnly
      ? `<p class="note">Building columns only. <a href="${base}">Add roof framing</a></p>`
      : `<p class="note">Building columns and roof framing. <a href="${base}&gen=columns">Columns only</a></p>`;
  }

  // ---------- hand-offs ----------
  function moreTools() {
    const items = [];
    if (p.kind === "frame") items.push(["Read the sketch with Ai", "Afshin's app reads a sketch photo with a Claude agent, then writes and opens the RISA model. Runs on your PC.", LINKS.afshin]);
    if (p.kind === "bldg") {
      items.push(["Find columns on the PDF", "Philip's floor-plan-columns skill locates columns, frames the roof and writes the .r3d. Runs in Claude Code.", LINKS.philip]);
      items.push(["Lay out framing with Ai", "Afshin's app lays out steel framing on a PDF plan with a Claude agent. Runs on your PC.", LINKS.afshin]);
    }
    if (!items.length) return "";
    return `<h3>More ways to build this model</h3>` + items.map(([t, d, href]) =>
      `<div class="card"><b>${esc(t)}</b><div class="note">${esc(d)}</div><div class="row" style="margin-top:10px"><a class="btn" href="${href}">Open</a></div></div>`).join("");
  }

  function handOff() {
    const tool = $("tool");
    if (p.kind === "truss") {
      tool.innerHTML = `
        <h2>Build the truss in Truss to RISA</h2>
        <p class="note">Olu's truss tool: start from a Fink, Howe/Pratt, flat-chord or mono template, or upload the drawing, straighten a skewed photo with four pins and trace or edit the nodes. It writes a RISA-3D .r3d.</p>
        <div class="row"><a class="btn primary" href="truss/">Open Truss to RISA</a></div>
        <ol class="note" style="margin-top:16px;padding-left:18px">
          <li>Download this project's sheet: <a href="#" id="dlSheet">Download sheet</a>.</li>
          <li>In Truss to RISA, open the drawing panel and upload it.</li>
          <li>To have Claude read the drawing, use the <a href="${LINKS.trussBeta}">claude.ai version</a>. The drawing reader only runs there.</li>
        </ol>`;
      MGStore.getFile(p.id).then((f) => {
        const a = $("dlSheet");
        if (!a) return;
        if (!f) { a.replaceWith(document.createTextNode("no sheet was uploaded for this project")); return; }
        a.href = URL.createObjectURL(f);
        a.download = f.name || "sheet";
      });
    } else {
      tool.innerHTML = `
        <h2>Build a miscellaneous frame</h2>
        <div class="card"><b>Trace it in the browser</b><div class="note">Find lines automatically or click node to node, set supports, then export DXF or RISA spreadsheet rows. Nothing to install.</div>
          <div class="row" style="margin-top:10px"><a class="btn primary" href="prototype/?project=${encodeURIComponent(p.id)}">Open the tracer</a></div></div>
        <div class="card"><b>Read it with Ai</b><div class="note">Afshin's app reads sketches and plans with a Claude agent, then writes and opens the RISA model. Runs on your PC.</div>
          <div class="row" style="margin-top:10px"><a class="btn" href="${LINKS.afshin}">Get the app</a></div></div>`;
    }
  }
})();
