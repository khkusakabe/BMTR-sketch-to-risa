// RISA-3D export. Everything here is a pure function of the model, so this file can change
// on its own without touching the drawing app.
//
// model: { nodes: [{id, x, y, support}], members: [{id, i, j}], ftPerPx }
//   node x, y are drawing pixels (y grows down the page); ftPerPx converts to feet.
// opts:  { roundIn: 0 | 1 | 3 | 6 | 12 (inches, 0 = none), plane: "XY" (elevation) | "XZ" (plan) }
"use strict";

window.RisaExport = (() => {
  function roundFt(v, roundIn) {
    if (!roundIn) return Math.round(v * 1000) / 1000;
    const step = roundIn / 12;
    return Math.round(Math.round(v / step) * step * 1000) / 1000;
  }

  // Origin is the lowest, leftmost node.
  function nodes(model, opts) {
    const s = model.ftPerPx || 1;
    const xs = model.nodes.map((n) => n.x), ys = model.nodes.map((n) => n.y);
    const x0 = Math.min(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
    const plan = opts.plane === "XZ";
    return model.nodes.map((n) => {
      const X = roundFt((n.x - x0) * s, opts.roundIn);
      // Elevation: Y is up from the lowest node. Plan: Z grows down the page from the top node.
      const Y = plan ? 0 : roundFt((yMax - n.y) * s, opts.roundIn);
      const Z = plan ? roundFt((n.y - yMin) * s, opts.roundIn) : 0;
      return { label: "N" + n.id, X, Y, Z, support: n.support || "" };
    });
  }

  function members(model) {
    return model.members.map((m) => ({ label: "M" + m.id, i: "N" + m.i, j: "N" + m.j }));
  }

  // RISA-3D Boundary Conditions use "Reaction" for a restrained direction.
  function supportRow(support) {
    const R = "Reaction";
    switch (support) {
      case "Fixed": return [R, R, R, R, R, R];
      case "Pinned": return [R, R, R, "", "", ""];
      case "Roller": return ["", R, "", "", "", ""];  // vertical (Y) only
      default: return null;
    }
  }

  // kind: "nodes" | "members" | "supports"; first row is the header
  function table(model, kind, opts) {
    const ns = nodes(model, opts);
    if (kind === "nodes") return [["Label", "X (ft)", "Y (ft)", "Z (ft)"], ...ns.map((n) => [n.label, n.X, n.Y, n.Z])];
    if (kind === "members") return [["Label", "I Node", "J Node"], ...members(model).map((m) => [m.label, m.i, m.j])];
    const rows = [["Node Label", "X", "Y", "Z", "MX", "MY", "MZ"]];
    for (const n of ns) { const r = supportRow(n.support); if (r) rows.push([n.label, ...r]); }
    return rows;
  }

  // tab-separated rows paste straight into RISA spreadsheets
  function tsv(rows) { return rows.map((r) => r.join("\t")).join("\r\n"); }

  function csv(model, opts) {
    const parts = ["NODES", tsv(table(model, "nodes", opts)), "",
                   "MEMBERS", tsv(table(model, "members", opts)), "",
                   "BOUNDARY CONDITIONS", tsv(table(model, "supports", opts))];
    return parts.join("\r\n").replace(/\t/g, ",");
  }

  // DXF R12: one LINE per member on layer MEMBERS, in feet, drawn in the X-Y plane
  function dxf(model, opts) {
    const s = model.ftPerPx || 1;
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    const yMax = Math.max(...model.nodes.map((n) => n.y));
    const x0 = Math.min(...model.nodes.map((n) => n.x));
    const P = (n) => [roundFt((n.x - x0) * s, opts.roundIn), roundFt((yMax - n.y) * s, opts.roundIn)];
    const out = ["0", "SECTION", "2", "ENTITIES"];
    for (const m of model.members) {
      const [x1, y1] = P(byId.get(m.i)), [x2, y2] = P(byId.get(m.j));
      out.push("0", "LINE", "8", "MEMBERS", "10", x1, "20", y1, "30", 0, "11", x2, "21", y2, "31", 0);
    }
    out.push("0", "ENDSEC", "0", "EOF");
    return out.join("\r\n") + "\r\n";
  }

  return { nodes, members, table, tsv, csv, dxf, roundFt };
})();
