#!/usr/bin/env node
// Sketch to RISA MCP server: exposes the team's RISA-3D generators (Final Models/*.js) as tools,
// so Claude Desktop or Claude Code can read a sketch itself and then write the .r3d.
// Zero dependencies: MCP over stdio is newline-delimited JSON-RPC 2.0. Logs go to stderr only.
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const GEN = (f) => require(path.join(ROOT, "Final Models", f));
const READER = () => require(path.join(ROOT, "mg", "sketch-reader.js"));  // same prompt, schema and checks as the website
const OUT_DEFAULT = path.join(ROOT, "out");
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

// ---------- inputs per generator (mirrors mg/generate.js) ----------
const num = (description) => ({ type: "number", description });
const shape = (description) => ({ type: "string", description });
const base = { type: "string", enum: ["Fixed", "Pinned"], description: "Base support: Fixed (all 6 DOF) or Pinned. A line over hatch at a column base in the sketch means Fixed." };
const ends = (which) => ({ type: "string", enum: ["fixed", "pinned"], description: `${which} beam end connections. A shaded triangle at a beam end in the sketch means fixed; no triangle means pinned.` });
const seismic = { rho: num("Redundancy factor rho for the ASD combinations (default 1.0)"), SDS: num("Design spectral acceleration SDS; Ev = 0.2*SDS*D (default 1.0)") };
const common = {
  output_dir: { type: "string", description: "Folder to write the .r3d into. Default: the repo's out/ folder." },
  file_name: { type: "string", description: "File name, for example Grid-1-frame.r3d. Default: based on the tool name." },
  template_path: { type: "string", description: "Optional RISA-saved .r3d to use as the template, to keep an office's materials, codes and settings." },
};

const GENERATORS = {
  build_moment_frame: {
    file: "moment-frame.js",
    description: "Write a RISA-3D v23 .r3d for a two-story, one-bay steel moment frame: nodes, supports, AISC W sections, members, basic load cases and ASCE 7-22 ASD load combinations. " +
      "Read the sketch yourself first: pen lines are members, labels (C1, B1, B2) are section sets, the size table gives the W shapes (struck-out sizes are void), dimension strings give the geometry. Omitted inputs use the defaults.",
    props: {
      bay: num("Bay width, ft"), h1: num("Base to Level 2, ft"), h2: num("Level 2 to roof, ft"),
      C1: shape("Column W shape, for example W12X35"), B2: shape("Level 2 beam W shape"), B1: shape("Roof beam W shape"),
      base, B1ends: ends("Roof"), B2ends: ends("Level 2"),
      deadB2: num("Dead load on the Level 2 beam, klf downward"), liveB2: num("Live load on the Level 2 beam, klf"),
      deadB1: num("Dead load on the roof beam, klf"), liveB1: num("Live load on the roof beam, klf"),
      windL2: num("Wind at Level 2, kips +X at the left column"), windRoof: num("Wind at the roof, kips +X"),
      eqL2: num("Seismic at Level 2, kips +X"), eqRoof: num("Seismic at the roof, kips +X"),
      ...seismic,
    },
  },
  build_roof_framing: {
    file: "roof-framing.js",
    description: "Write a RISA-3D v23 .r3d for a one-story building: columns on a grid plus steel roof beams at the column tops, loads by tributary area, ASCE 7-22 ASD combinations. " +
      "Layout: corner columns C1, edge columns C3 (first/last row rotated 90 deg), interior columns C2 (HSS). Roof beams: perimeter end bays B1 (pinned), perimeter middle bays B2 (fixed), interior lines B3 (pinned). Omitted inputs use the defaults.",
    props: {
      xSp: { type: "array", items: { type: "number" }, description: "Grid spacings along X, ft, for example [10, 15, 10]" },
      zSp: { type: "array", items: { type: "number" }, description: "Grid spacings along Z, ft; row 1 is Z = 0 (top of the sketch)" },
      H: num("Column height, ft"),
      C1: shape("Corner column W shape"), C3: shape("Edge column W shape"), C2: shape("Interior column HSS shape, for example HSS5X5X3/8"), base,
      B1: shape("Roof beam W shape, perimeter end bays"), B2: shape("Roof beam W shape, perimeter middle bays"), B3: shape("Roof beam W shape, interior lines"),
      D: num("Dead load, psf"), L: num("Live load, psf"), WX: num("Total wind in X, kips"), WZ: num("Total wind in Z, kips"),
      Cs: num("Seismic coefficient"), Wsw: num("Seismic weight, kips (omit to use D x area)"),
      ...seismic,
    },
  },
  build_foundation_plan: {
    file: "foundation-plan.js",
    description: "Write a RISA-3D v23 .r3d with columns only on a grid (no roof beams): corner C1, edge C3, interior C2 (HSS), loads by tributary area, ASCE 7-22 ASD combinations. Omitted inputs use the defaults.",
    props: null,  // filled below: roof framing inputs without the roof beams
  },
};
{
  const { B1, B2, B3, ...rest } = GENERATORS.build_roof_framing.props;
  GENERATORS.build_foundation_plan.props = rest;
}

const TOOLS = [
  ...Object.entries(GENERATORS).map(([name, g]) => ({
    name,
    description: g.description,
    inputSchema: { type: "object", properties: { ...g.props, ...common }, additionalProperties: false },
  })),
  {
    name: "list_shapes",
    description: "List AISC shape names the generators accept (from the AISC Shapes Database tables they carry). Use it to check a size read from a sketch.",
    inputSchema: {
      type: "object",
      properties: {
        family: { type: "string", enum: ["W", "HSS"], description: "Shape family" },
        contains: { type: "string", description: "Optional filter, for example W12 or 5X5" },
      },
      required: ["family"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sketch_reading_instructions",
    description: "Get the team's sketch-reading rules and the JSON format for a reading (nodes, members with section sets and end fixity, supports, size table, dimensions). " +
      "Call this before reading a framing sketch, then reply with the JSON reading. The user can paste it into the website's 'Use Claude's answer' box, or pass it to convert_sketch_reading.",
    inputSchema: {
      type: "object",
      properties: {
        hint: { type: "string", description: "What the engineer says it is, for example 2D Frame or 3D Building" },
        width: { type: "number", description: "Image width in px, if known (for node positions)" },
        height: { type: "number", description: "Image height in px, if known" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "convert_sketch_reading",
    description: "Check a sketch reading (the JSON from get_sketch_reading_instructions) and turn it into generator inputs: build_moment_frame inputs for a frame elevation, or build_roof_framing / build_foundation_plan inputs for a column grid. " +
      "Returns the inputs, anything to check, and the reading ready to paste into the website.",
    inputSchema: {
      type: "object",
      properties: {
        reading: { description: "The reading, as a JSON object or as the text of Claude's answer" },
        target: { type: "string", enum: ["moment_frame", "grid"], description: "Which generator to prepare inputs for. Default: from the reading's system" },
      },
      required: ["reading"],
      additionalProperties: false,
    },
  },
  {
    name: "get_defaults",
    description: "Show the default inputs a generator uses when a value is omitted.",
    inputSchema: {
      type: "object",
      properties: { generator: { type: "string", enum: Object.keys(GENERATORS) } },
      required: ["generator"],
      additionalProperties: false,
    },
  },
];

// ---------- tool calls ----------
function count(text, re) { const m = text.match(re); return m ? Number(m[1]) : null; }

function runGenerator(name, args) {
  const g = GENERATORS[name];
  const R = GEN(g.file);
  const inputs = {}, opts = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (k in common) continue;
    if (!(k in g.props)) throw new Error(`Unknown input "${k}"`);
    inputs[k] = v;
  }
  if (args.template_path) opts.template = fs.readFileSync(path.resolve(args.template_path), "utf8");
  const text = R.build(inputs, opts).replace(/\r?\n/g, "\r\n");  // RISA expects Windows line endings

  const dir = path.resolve(args.output_dir || OUT_DEFAULT);
  fs.mkdirSync(dir, { recursive: true });
  let file = (args.file_name || name.replace(/^build_/, "").replace(/_/g, "-") + ".r3d").replace(/[\\/:*?"<>|]+/g, "_");
  if (!/\.r3d$/i.test(file)) file += ".r3d";
  const full = path.join(dir, file);
  fs.writeFileSync(full, text);

  const used = { ...R.DEFAULTS, ...inputs };
  const nodes = count(text, /^\[NODES\]\s*<(\d+)>/m);
  const members = count(text, /^\[\.?MEMBERS_MAIN_DATA\]\s*<(\d+)>/m);
  const combos = count(text, /^\[LOAD_COMBINATIONS\]\s*<(\d+)>/m);
  return [
    `Wrote ${full}`,
    `${nodes} nodes, ${members} members, ${combos} load combinations (ASCE 7-22 ASD).`,
    `Inputs used: ${JSON.stringify(used)}`,
    "This is a starting model. The engineer opens it in RISA-3D and checks geometry, sections, loads, supports and connections.",
  ].join("\n");
}

function callTool(name, args) {
  if (GENERATORS[name]) return runGenerator(name, args || {});
  if (name === "list_shapes") {
    const S = GEN("roof-framing.js").shapes();
    const list = args.family === "HSS" ? S.HSSlist : S.Wlist;
    const q = (args.contains || "").toUpperCase();
    const hits = q ? list.filter((s) => s.toUpperCase().includes(q)) : list;
    return `${hits.length} ${args.family} shapes${q ? ` containing "${q}"` : ""}:\n${hits.join(", ")}`;
  }
  if (name === "get_sketch_reading_instructions") {
    return READER().promptFor({ hint: args.hint, width: args.width, height: args.height });
  }
  if (name === "convert_sketch_reading") {
    const SR = READER();
    const S = GEN("roof-framing.js").shapes();
    const shapes = new Set([...S.Wlist, ...S.HSSlist]);
    const text = typeof args.reading === "string" ? args.reading : JSON.stringify(args.reading);
    const r = SR.parse(text, { shapes });
    const target = args.target || (r.system === "moment_frame" || r.system === "braced_frame" ? "moment_frame" : "grid");
    const { inputs, warnings } = target === "moment_frame" ? SR.toMomentFrame(r) : SR.toGrid(r);
    const checks = [...(r.problems || []), ...warnings];
    const { image, problems, ...forWebsite } = r;
    return [
      `Read ${r.nodes.length} nodes and ${r.members.length} members (${r.system.replace(/_/g, " ")}).`,
      `Inputs for ${target === "moment_frame" ? "build_moment_frame" : "build_roof_framing or build_foundation_plan"} (loads aren't on the sketch; add them): ${JSON.stringify(inputs)}`,
      checks.length ? `Check these: ${checks.join(" | ")}` : "No problems found in the reading.",
      "Reading for the website's 'Use Claude's answer' box:",
      "```json",
      JSON.stringify(forWebsite),
      "```",
    ].join("\n");
  }
  if (name === "get_defaults") {
    const g = GENERATORS[args.generator];
    if (!g) throw new Error(`Unknown generator "${args.generator}"`);
    return JSON.stringify(GEN(g.file).DEFAULTS, null, 2);
  }
  throw new Error(`Unknown tool "${name}"`);
}

// ---------- JSON-RPC over stdio ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "sketch-to-risa", version: "0.2.0" },
        instructions: "Tools that write RISA-3D .r3d models from framing inputs. To read a sketch, call get_sketch_reading_instructions, read the sketch into that JSON format, call convert_sketch_reading, confirm the dimensions and sizes with the user, then call a build tool. The result is a starting model for an engineer to check in RISA.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call":
      try {
        const text = callTool(params.name, params.arguments || {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (err) {
        return reply(id, { content: [{ type: "text", text: "Error: " + (err && err.message ? err.message : String(err)) }], isError: true });
      }
    default:
      if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
      return undefined;  // notifications (initialized, cancelled) need no reply
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return fail(null, -32700, "Parse error"); }
  try { handle(msg); } catch (e) { log("sketch-to-risa:", e.stack || e); if (msg.id != null) fail(msg.id, -32603, String(e.message || e)); }
});
log("sketch-to-risa MCP server ready");
