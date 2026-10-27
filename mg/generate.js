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
      intro: "Two-story, one-bay steel moment frame (Chandler's Moment Frame generator). Beam ends are fixed; base is as selected.",
      groups: [
        ["Geometry", [["bay", "Bay width", "ft"], ["h1", "Base to Level 2", "ft"], ["h2", "Level 2 to roof", "ft"]]],
        ["Sections", [["C1", "Columns", "W", "W"], ["B2", "Level 2 beam", "W", "W"], ["B1", "Roof beam", "W", "W"], ["base", "Base", "", "base"]]],
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

  showPlan();
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
      } else {
        const img = new Image();
        img.src = URL.createObjectURL(file);
        img.alt = "Uploaded plan sheet";
        box.replaceChildren(img);
      }
    } catch (err) {
      box.innerHTML = `<span class="meta">Could not show this file: ${esc(err.message)}</span>`;
    }
    $("planActions").innerHTML =
      `<a class="btn" href="prototype/?project=${encodeURIComponent(p.id)}">Trace or find lines on this sheet</a>`;
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

    $("mgForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target, inputs = {};
      for (const [, fields] of spec.groups) {
        for (const [k, , , type] of fields) {
          const raw = form.elements[k].value.trim();
          if (type === "list") inputs[k] = raw.split(/[,\s]+/).filter(Boolean).map(Number);
          else if (type === "W" || type === "HSS" || type === "base") inputs[k] = raw;
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
        <p class="note">Start from a Fink, Howe/Pratt, flat-chord or mono template, or upload this sheet and let Claude read it. It writes a RISA-3D .r3d. Runs on claude.ai.</p>
        <div class="row"><a class="btn primary" href="${LINKS.truss}">Open Truss to RISA</a><a class="btn" href="${LINKS.trussBeta}">Beta: photo straightening</a></div>
        <p class="note" style="margin-top:16px">Upload the same plan sheet there. It doesn't read files from this page.</p>`;
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
