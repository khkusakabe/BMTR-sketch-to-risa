// Reads a framing sketch or plan sheet with Claude (vision) and returns structured geometry:
// nodes in feet, members with section-set labels and end fixity, supports, the size table,
// and the generator inputs (bay and story heights, or grid spacings).
//
// Two ways to read, both in the browser:
//   - No key: promptFor() gives a prompt to paste into the user's own Claude (claude.ai, Claude
//     Desktop, Claude Code) with the sheet attached; parse() turns Claude's JSON answer into a reading.
//   - API key: read() calls the Anthropic API from this page with the user's own key, kept in this
//     browser's localStorage only.
// Also loads in Node (module.exports) so the MCP server can share the prompt, schema and checks.
// Sketch nomenclature (Model Creator rules):
//   pen-drawn lines are members (printed ruled lines are ignored); a shaded triangle at a beam end
//   is a fixed (moment) connection; a horizontal line over diagonal hatch at a base is a fixed base;
//   beams with no fixed mark are pinned; labels (C1, B1...) are section sets; a size table assigns
//   shapes (a struck-out size is void, use its replacement); dimension strings give geometry in feet.
"use strict";

const SketchReaderLib = (() => {
  const KEY = "mg-anthropic-key";
  const MODEL = "claude-opus-5-5";
  const MAX_PX = 1568;  // long side of the image sent to the model

  const getKey = () => { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } };
  const setKey = (k) => { try { k ? localStorage.setItem(KEY, k.trim()) : localStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ } };

  const SYSTEM = `You read hand sketches and plan sheets of steel framing and return exact model data for RISA-3D.

Sketch nomenclature (applies to every sketch):
- Pen-drawn lines are members. Ignore the paper's printed ruled lines, margins and grid paper.
- A shaded (filled) triangle at a beam end means that end is FIXED (moment connection, no release).
- A beam end with no shaded triangle is PINNED. Assume beams are pinned unless marked fixed.
- A horizontal line over diagonal hatch lines at a column base is a FIXED base (all six DOF restrained).
- A small open triangle under a node is a PINNED support; a circle or roller symbol is a ROLLER.
- A label written beside a member (C1, B1, B2...) is its section set. The same label may be used on several members.
- A size table (e.g. "C1 = W12X35") assigns the shape for each section set. A crossed-out or struck size is void: use the replacement written beside it, and report the struck one.
- Dimension strings give the geometry in feet. Lengths come only from written dimensions, never from measuring the drawing, which is not to scale. Stacked dimensions along one side add up (e.g. 15' then 10' above it = levels at 15 and 25 ft).
- A sketched coordinate axis shows the global axes to use.

Coordinates you return:
- x_ft to the right, y_ft UP the sheet, in feet, origin (0,0) at the lowest-left node of the framing.
- For an elevation, y is height. For a plan, y is the distance up the sheet.
- px_x and px_y are your best estimate of where that node sits in the image you were given, in image pixels with the origin at the top-left corner (y grows downward). These only help line the model up with the image; the feet values are what matter.

Model rules:
- Put a node at every member end, every support, and every point where members meet (a beam framing into a column makes a node on the column).
- Split columns at every level where a beam frames in, so each member runs between two adjacent nodes. Give each piece the column's section set.
- Write shapes as RISA spells them: W12X35, HSS5X5X3/8 (capital X). Use only real AISC shapes.
- Set system to the type of structure you see. For a one-bay frame report the bay width and the story heights bottom to top. For a column grid plan report the spacings between grid lines, left to right and top to bottom.
- In notes, list every reading you were unsure of and every assumption you made, in plain words (e.g. "B1 = W12X22; W16X26 was struck"). Never guess silently.`;

  const TOOL = {
    name: "report_sketch",
    description: "Report the structural model read from the sketch.",
    input_schema: {
      type: "object",
      properties: {
        system: { type: "string", enum: ["moment_frame", "braced_frame", "column_plan", "roof_framing_plan", "truss", "other"] },
        view: { type: "string", enum: ["elevation", "plan"] },
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              x_ft: { type: "number" }, y_ft: { type: "number" },
              px_x: { type: "number" }, px_y: { type: "number" },
            },
            required: ["id", "x_ft", "y_ft", "px_x", "px_y"],
          },
        },
        members: {
          type: "array",
          items: {
            type: "object",
            properties: {
              section_set: { type: "string", description: "Label written on the sketch, e.g. C1, B2" },
              role: { type: "string", enum: ["column", "beam", "brace", "chord", "web", "other"] },
              i: { type: "string" }, j: { type: "string" },
              i_end: { type: "string", enum: ["fixed", "pinned"] },
              j_end: { type: "string", enum: ["fixed", "pinned"] },
            },
            required: ["section_set", "role", "i", "j", "i_end", "j_end"],
          },
        },
        supports: {
          type: "array",
          items: {
            type: "object",
            properties: { node: { type: "string" }, type: { type: "string", enum: ["Fixed", "Pinned", "Roller"] } },
            required: ["node", "type"],
          },
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: { set: { type: "string" }, shape: { type: "string" }, struck: { type: "array", items: { type: "string" } } },
            required: ["set", "shape"],
          },
        },
        frame: {
          type: "object",
          description: "For a one-bay frame: bay width and story heights bottom to top",
          properties: { bay_ft: { type: "number" }, story_heights_ft: { type: "array", items: { type: "number" } } },
        },
        grid: {
          type: "object",
          description: "For a column grid plan",
          properties: {
            x_spacings_ft: { type: "array", items: { type: "number" } },
            y_spacings_ft: { type: "array", items: { type: "number" }, description: "top to bottom of the sheet" },
            column_height_ft: { type: "number" },
          },
        },
        dimensions_read: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } },
      },
      required: ["system", "view", "nodes", "members", "supports", "sections", "notes"],
    },
  };

  // Any drawable (img, canvas, ImageBitmap) -> JPEG at most MAX_PX on the long side
  function encode(source) {
    const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
    const k = Math.min(1, MAX_PX / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(source, 0, 0, c.width, c.height);
    return { data: c.toDataURL("image/jpeg", 0.9).split(",")[1], width: c.width, height: c.height, scale: k };
  }

  // A File (image) or anything drawable -> drawable
  async function toDrawable(src) {
    if (src instanceof Blob) {
      const img = new Image();
      img.src = URL.createObjectURL(src);
      await new Promise((res, rej) => { if (img.complete && img.naturalWidth) return res(); img.onload = () => res(); img.onerror = () => rej(new Error("This image could not be opened.")); });  // load event: decode() can stall in some browsers
      return img;
    }
    return src;
  }

  // opts.hint: what the user said this is ("2D Frame", "3D Building"...); opts.shapes: known shape names
  async function read(src, opts = {}) {
    const key = opts.key || getKey();
    if (!key) throw new Error("Add your Anthropic API key first.");
    const img = encode(await toDrawable(src));
    const ask = `This image is ${img.width} x ${img.height} px.` +
      (opts.hint ? ` The engineer says this is a ${opts.hint}.` : "") +
      " Read the sketch and report the model with the report_sketch tool.";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "report_sketch" },
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.data } },
          { type: "text", text: ask },
        ] }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error && body.error.message || res.statusText;
      if (res.status === 401) throw new Error("The API key was rejected. Check it and try again.");
      throw new Error(`Claude couldn't read the sketch (${res.status}): ${msg}`);
    }
    if (body.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off. Try a tighter crop of the framing.");
    const use = (body.content || []).find((b) => b.type === "tool_use");
    if (!use) throw new Error("Claude didn't return a model for this image.");
    const r = use.input;
    r.image = { width: img.width, height: img.height, scale: img.scale };  // scale = sent px / source px
    r.problems = check(r, opts.shapes);
    return r;
  }

  // Code checks on what came back. Empty list = consistent.
  function check(r, shapes) {
    const p = [];
    const ids = new Set((r.nodes || []).map((n) => n.id));
    for (const m of r.members || []) {
      if (!ids.has(m.i) || !ids.has(m.j)) p.push(`Member ${m.section_set} ${m.i}-${m.j} refers to a node that isn't listed.`);
      else if (m.i === m.j) p.push(`Member ${m.section_set} starts and ends at ${m.i}.`);
    }
    for (const s of r.supports || []) if (!ids.has(s.node)) p.push(`Support at ${s.node} isn't on a listed node.`);
    if (shapes) for (const s of r.sections || []) {
      const name = normShape(s.shape);
      if (!shapes.has(name)) p.push(`${s.set} = ${s.shape} isn't in the AISC table. Check the handwriting.`);
    }
    const used = new Set((r.members || []).map((m) => m.section_set));
    for (const set of used) if (!(r.sections || []).some((s) => s.set === set)) p.push(`No size was read for ${set}.`);
    return p;
  }

  const normShape = (s) => String(s || "").toUpperCase().replace(/\s+/g, "").replace(/×/g, "X");
  const sizeOf = (r, set) => { const s = (r.sections || []).find((x) => x.set.toUpperCase() === set.toUpperCase()); return s ? normShape(s.shape) : null; };

  // Reading -> Moment Frame generator inputs (one bay, two levels). Returns { inputs, warnings }.
  function toMomentFrame(r) {
    const out = {}, warn = [];
    const nodes = new Map((r.nodes || []).map((n) => [n.id, n]));
    const beams = (r.members || []).filter((m) => m.role === "beam");
    const cols = (r.members || []).filter((m) => m.role === "column");
    const xs = [...new Set((r.nodes || []).map((n) => Math.round(n.x_ft * 100) / 100))].sort((a, b) => a - b);
    let levels = [...new Set(beams.flatMap((m) => [nodes.get(m.i), nodes.get(m.j)]).filter(Boolean).map((n) => Math.round(n.y_ft * 100) / 100))].sort((a, b) => a - b);
    const f = r.frame || {};
    const bay = f.bay_ft || (xs.length >= 2 ? xs[xs.length - 1] - xs[0] : null);
    const hs = (f.story_heights_ft && f.story_heights_ft.length) ? f.story_heights_ft : levels.map((y, k) => y - (k ? levels[k - 1] : 0));
    if (bay) out.bay = bay;
    if (hs.length >= 1) out.h1 = hs[0];
    if (hs.length >= 2) out.h2 = hs[1];
    if (xs.length > 2) warn.push(`The sketch has ${xs.length - 1} bays; the Moment Frame generator builds one. Use the tracer for the full geometry.`);
    if (hs.length !== 2) warn.push(`The sketch has ${hs.length} ${hs.length === 1 ? "level" : "levels"}; the Moment Frame generator builds two.`);

    // Roof beam is B1, Level 2 beam is B2 (Model 1 convention); take the labels from the sketch
    const beamAt = (lvl) => beams.find((m) => { const a = nodes.get(m.i); return a && Math.abs(a.y_ft - lvl) < 0.05; });
    const top = levels.length ? beamAt(levels[levels.length - 1]) : null;
    const low = levels.length > 1 ? beamAt(levels[levels.length - 2]) : null;
    const ends = (m) => (m.i_end === "fixed" && m.j_end === "fixed") ? "fixed" : "pinned";
    if (top) { const s = sizeOf(r, top.section_set); if (s) out.B1 = s; out.B1ends = ends(top);
      if (top.i_end !== top.j_end) warn.push(`${top.section_set} has one fixed end and one pinned end; written as pinned both ends.`); }
    if (low) { const s = sizeOf(r, low.section_set); if (s) out.B2 = s; out.B2ends = ends(low);
      if (low.i_end !== low.j_end) warn.push(`${low.section_set} has one fixed end and one pinned end; written as pinned both ends.`); }
    if (cols.length) { const s = sizeOf(r, cols[0].section_set); if (s) out.C1 = s;
      if (new Set(cols.map((c) => c.section_set)).size > 1) warn.push("The columns have different labels; the generator uses one column size (C1)."); }
    const baseY = Math.min(...(r.nodes || [{ y_ft: 0 }]).map((n) => n.y_ft));
    const bases = (r.supports || []).filter((s) => nodes.get(s.node) && Math.abs(nodes.get(s.node).y_ft - baseY) < 0.05);
    if (bases.length) {
      out.base = bases.every((s) => s.type === "Fixed") ? "Fixed" : "Pinned";
      if (new Set(bases.map((s) => s.type)).size > 1) warn.push("The two bases are drawn differently; written as " + out.base + ".");
    } else warn.push("No base support marks were found; the base was left as it was.");
    return { inputs: out, warnings: warn };
  }

  // Reading -> Roof Framing / Foundation Plan generator inputs
  function toGrid(r) {
    const out = {}, warn = [], g = r.grid || {};
    if (g.x_spacings_ft && g.x_spacings_ft.length) out.xSp = g.x_spacings_ft;
    if (g.y_spacings_ft && g.y_spacings_ft.length) out.zSp = g.y_spacings_ft;
    if (g.column_height_ft) out.H = g.column_height_ft;
    for (const set of ["C1", "C2", "C3", "B1", "B2", "B3"]) { const s = sizeOf(r, set); if (s) out[set] = s; }
    if (!out.xSp || !out.zSp) warn.push("Grid spacings weren't read in both directions. Enter them below.");
    if (!out.H) warn.push("No column height on the sheet. Check the height below.");
    const t = new Set((r.supports || []).map((s) => s.type));
    if (t.size === 1) out.base = t.has("Fixed") ? "Fixed" : "Pinned";
    return { inputs: out, warnings: warn };
  }

  // ---------- no-key path: the user's own Claude reads the sheet ----------
  // width/height: the sheet's size in pixels, so node positions line up with it in the tracer.
  function promptFor(opts = {}) {
    const size = opts.width && opts.height ? ` The attached image is ${opts.width} x ${opts.height} px; give px_x and px_y in that frame.` : "";
    return [
      SYSTEM,
      "",
      `Read the attached sketch.${opts.hint ? ` The engineer says this is a ${opts.hint}.` : ""}${size}`,
      "Answer with ONE JSON object and nothing else, in a ```json code block, that matches this JSON Schema:",
      "```json",
      JSON.stringify(TOOL.input_schema),
      "```",
    ].join("\n");
  }

  // Claude's pasted answer (a ```json block or bare JSON, possibly with text around it) -> reading
  function parse(text, opts = {}) {
    const t = String(text || "");
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let body = fenced ? fenced[1] : t;
    const a = body.indexOf("{"), b = body.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("That doesn't look like Claude's answer. Paste the whole JSON block it returned.");
    let r;
    try { r = JSON.parse(body.slice(a, b + 1)); } catch (e) { throw new Error("Claude's answer isn't valid JSON. Ask it to resend just the JSON block."); }
    if (r && r.input && !r.nodes) r = r.input;  // tolerate a tool-call wrapper
    for (const k of ["nodes", "members"]) if (!Array.isArray(r[k])) throw new Error(`Claude's answer has no ${k} list. Ask it to follow the JSON format.`);
    for (const k of ["supports", "sections", "notes"]) if (!Array.isArray(r[k])) r[k] = [];
    if (!r.system) r.system = "other";
    if (!r.view) r.view = "elevation";
    r.image = { width: opts.width || 1000, height: opts.height || 1000, scale: 1 };
    r.problems = check(r, opts.shapes);
    return r;
  }

  return { read, getKey, setKey, toMomentFrame, toGrid, normShape, MODEL, promptFor, parse, check, SYSTEM, TOOL };
})();
if (typeof window !== "undefined") window.SketchReader = SketchReaderLib;
if (typeof module !== "undefined" && module.exports) module.exports = SketchReaderLib;
