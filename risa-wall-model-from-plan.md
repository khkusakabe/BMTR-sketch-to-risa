---
name: risa-wall-model-from-plan
description: Build a RISA-3D importable DXF wall model (plus node CSV and section-set table) for a 1-story building from a conceptual floor plan PDF, with exterior and interior walls grouped by section set, and an optional web app for choosing wall types.
---

# RISA-3D Wall Model from a Conceptual Floor Plan

Generate a RISA-3D importable wall model of a 1-story building from a conceptual floor plan. The outputs are:

- a DXF of the walls, with one layer per section set
- a node coordinate CSV
- a section-set table
- optionally, a web app where the user picks the "Exterior wall type" and "Interior wall type" and exports the package

## Inputs to collect

| Input | Source | Default if not given |
|---|---|---|
| Floor plan | PDF/image the user names (find it on their computer or in uploads) | — (required) |
| Which plan on the sheet | User ("right side", "floor plan 1", etc.) | Ask if the sheet has several |
| Exterior wall type | User or web app | 8" CMU, fully grouted |
| Interior wall type | User or web app | 3-5/8" CFS 362S125-33 @ 16" |
| Wall height | User | 18'-0" (flag it as a placeholder) |
| Plate mesh size | User | 4'-0" |
| Include minor partitions (restrooms, etc.) | User | Yes, flagged as approximate |

## Conventions

- **Units:** feet in the DXF and CSV. In the RISA DXF import, set units to feet.
- **RISA global axes (Y-up):**
  - X runs along the numbered grids (1 → 2 …).
  - Y is vertical.
  - Z runs along the lettered grids (A → B …), so plan "down the sheet" is +Z.
- **Wall location:** model each wall on its centerline. Exterior walls sit on the outer grid lines unless the plan dimensions them off-grid.
- **Section sets = DXF layers.** R12 layer names allow only letters, digits, `_`, `-` and `$`, so no spaces.
  - `EXTERIOR_WALLS`: exterior studs or plates
  - `EXTERIOR_WALLS_TRACK`: exterior top and bottom tracks (stud walls only)
  - `INTERIOR_WALLS`: interior studs or plates
  - `INTERIOR_WALLS_TRACK`: interior top and bottom tracks (stud walls only)
- **Element type follows the wall type:**
  - Masonry or concrete walls become **plates**, written as `3DFACE` entities.
  - Stud walls (CFS or wood) become **members**, written as `LINE` entities: studs at the type's spacing plus top and bottom tracks.

## Procedure

### 1. Read the plan

1. Stage or read the PDF. Rasterize it at about 200 dpi (`pdftoppm -r 200 -png`) and crop to the requested floor plan so the dimension strings are legible.
2. Record the following:
   - grid labels and spacings, from the dimension strings
   - overall dimensions
   - the location of every wall to be modeled
3. Reconcile the numbers:
   - If the bay dimensions don't sum to the overall dimension because of drafting round-off (e.g. 3 × 39'-5" = 118'-3" vs 118'-4"), keep the overall dimension and absorb the difference in the last bay. Note it.
   - Where walls are not dimensioned, locate them from labeled areas (area ÷ building width = depth). For example, 3,500 sf / 60' = 58'-4" and 1,200 sf / 60' = 20'-0".
   - Cross-check every derived location by scaling pixels: px/ft = (grid-to-grid px) ÷ (grid-to-grid ft).
4. Scale minor partitions (restrooms, closets) from the image and flag them as approximate.
5. Exclude openings (storefronts, doors) and annex rooms outside the main grid unless the user asks for them. List the exclusions.

### 2. Define the wall list

Write each wall as `{set: "EXT" | "INT", a: [x, z], b: [x, z]}` in feet.

### 3. Find breakpoints on each wall

For each wall, collect the parameters `t` (distance from point `a`) of:

- its own ends
- every other wall's endpoint that lies on it (T- and L-junctions)
- every crossing with another wall

Sort and de-duplicate these within 1e-4 ft. Nodes are generated only at breakpoints and mesh points, and every wall gets a node at every junction, so the walls connect.

### 4. Set the vertical levels

- If any wall uses plates: `n = ceil(H / mesh)` and levels are `H·k/n` for k = 0…n.
- If all walls are members: the levels are `[0, H]` only.

### 5. Generate elements

**Plate walls**

- Subdivide each interval between breakpoints into `ceil(Δt / mesh)` equal parts.
- For each panel × level band, write one `3DFACE` with corners in this order: bottom-start, bottom-end, top-end, top-start.

**Stud walls**

- Stud positions:
  - all breakpoints
  - plus `k·spacing` from the wall start
  - drop any regular stud within 3" of a breakpoint
- Studs at junctions are split at every vertical level, so they share nodes with any plate wall that meets them. Other studs run 0 → H.
- Tracks at Y = 0 and Y = H run as separate members between consecutive studs, on the `*_TRACK` layer.

**De-duplication**

- Nodes: key on coordinates rounded to 1e-4 ft.
- Members: key on the sorted node pair, so shared junction studs and corners appear only once.

### 6. Label the nodes

Sort the nodes by Y, then Z, then X, and label them `N1…Nn`.

### 7. Write the outputs

- **DXF**, in R12 ASCII (`AC1009`):
  - HEADER with `$INSUNITS = 2` (feet)
  - TABLES/LAYER entries for each layer (color 4 for exterior, 30 for interior)
  - ENTITIES: `LINE` (10/20/30 and 11/21/31) and `3DFACE` (10–13 / 20–23 / 30–33)
  - CRLF line endings
- Also produce **exterior-only** and **interior-only** DXFs, so each import can be given its own properties reliably.
- **Node CSV:** `Label,X [ft],Y [ft],Z [ft],Temp [F],Detach From Diaphragm`, which matches the column order of RISA-3D's Node Coordinates spreadsheet. Paste the data rows into that spreadsheet.
- **Section set CSV:** `Section Set / Layer, Element, Shape, Material, Plate Thickness, Wall Type`.

### 8. Verify

- Open the DXF with `ezdxf` and count entities by type and layer.
- Confirm every node is used by at least one member or plate (no orphans).
- Run at least these combinations: plate exterior + stud interior, stud exterior + plate interior, and all studs.

### 9. Deliver

- Send the DXF and CSVs, and write them beside the source plan when the user's folder is connected.
- If the user wants a web app for wall-type inputs, build it as one self-contained HTML artifact:
  - radio groups for **Exterior wall type** and **Interior wall type**
  - inputs for height, mesh and partitions
  - a live plan preview (SVG, grids with bubbles, walls colored by set)
  - node, member and plate counts
  - the section-set table
  - export through the artifact `downloads` capability as a **.zip**, because `.dxf` is not an allowed download extension; write a store-only zip with CRC32
  - "Copy DXF text" and "Copy node CSV" as fallbacks
  - inline the same generator code the files were built with, so the page and the files never diverge

## Wall type library (starting point)

**Exterior**

| ID | Wall type | Element | Shape / track | Material | Thk |
|---|---|---|---|---|---|
| cmu8 | 8" CMU, fully grouted | Plate | — | CMU f'm = 2,000 psi | 7.625" |
| tilt7 | 7-1/4" tilt-up | Plate | — | Concrete f'c = 4,000 psi | 7.25" |
| cfs600_54 | 6" CFS @ 16" | Member | 600S162-54 / 600T125-54 | A653 SS Gr 50 | — |
| cfs600_68 | 6" CFS @ 16" | Member | 600S162-68 / 600T125-68 | A653 SS Gr 50 | — |
| wood2x6 | 2x6 @ 16" | Member | 2X6 / 2X6 | DF-L No. 2 | — |

**Interior**

| ID | Wall type | Element | Shape / track | Material | Thk |
|---|---|---|---|---|---|
| cfs362_33 | 3-5/8" CFS @ 16" | Member | 362S125-33 / 362T125-33 | A653 SS Gr 33 | — |
| cfs600_43 | 6" CFS @ 16" | Member | 600S162-43 / 600T125-43 | A653 SS Gr 33 | — |
| wood2x4 | 2x4 @ 16" | Member | 2X4 / 2X4 | DF-L No. 2 | — |
| cmu8i | 8" CMU, fully grouted | Plate | — | CMU f'm = 2,000 psi | 7.625" |

Confirm shape names against the RISA shape database in the user's version.

## RISA import steps (tell the user)

1. File → Import → DXF. Set units to feet and Y as the vertical axis. The model is already Y-up, so don't rotate it.
2. Run Model Merge to catch duplicate nodes and members.
3. Assign properties:
   - members: section sets by layer, or import the exterior and interior DXFs separately
   - plates: material and thickness
4. Add supports at Y = 0, member end releases (pinned studs), and diaphragms or roof framing as the design requires.

## Confidence and limits (state these in the reply)

- **DXF structure:** high confidence. It is verified by parser and orphan check.
- **RISA mapping `3DFACE` → plates and keeping layer groupings on import:** medium confidence until tested in the user's RISA version.
- **Native `.r3d` files:** never generate one. The format is proprietary and undocumented; offer DXF or spreadsheet paste instead.
- **Approximate and placeholder inputs:** wall height, scaled partitions, and walls located from areas are approximate. List them.
- **Professional review:** all output is a conceptual starting point for review by the engineer of record.

## Reference implementation (JavaScript, runs in Node and the browser)

```js
// gen.js — core generator. Replace GRID / wallList() for a new plan.
const FT = (f, i = 0) => f + i / 12;
const GRID = { x: [["1", 0], ["2", 60]],
               z: [["A", 0], ["B", FT(39, 5)], ["C", FT(78, 10)], ["D", FT(118, 4)]] };
const BLD_W = 60, BLD_L = FT(118, 4);
const DEMISING_Z = [FT(58, 4), FT(78, 4), FT(98, 4)];
const SETS = { EXT: { label: "EXTERIOR_WALLS" }, INT: { label: "INTERIOR_WALLS" } };

function wallList(o) {
  const w = [], E = (a, b) => w.push({ set: "EXT", a, b }), I = (a, b) => w.push({ set: "INT", a, b });
  E([0, 0], [BLD_W, 0]); E([BLD_W, 0], [BLD_W, BLD_L]); E([BLD_W, BLD_L], [0, BLD_L]); E([0, BLD_L], [0, 0]);
  DEMISING_Z.forEach(z => I([0, z], [BLD_W, z]));
  if (o.restrooms) { /* add scaled partitions here */ }
  return w;
}

const uniq = (a, tol = 1e-4) => { const s = [...a].sort((x, y) => x - y), r = [];
  for (const v of s) if (!r.length || v - r[r.length - 1] > tol) r.push(v); return r; };
function segParam(w, p) { const [ax, az] = w.a, [bx, bz] = w.b, dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
  if (Math.abs((p[0] - ax) * dz - (p[1] - az) * dx) / L > 1e-4) return null;
  const t = ((p[0] - ax) * dx + (p[1] - az) * dz) / L; return t >= -1e-4 && t <= L + 1e-4 ? Math.min(Math.max(t, 0), L) : null; }
function intersect(w1, w2) { const [x1, z1] = w1.a, [x2, z2] = w1.b, [x3, z3] = w2.a, [x4, z4] = w2.b;
  const d = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4); if (Math.abs(d) < 1e-6) return null;
  const t = ((x1 - x3) * (z3 - z4) - (z1 - z3) * (x3 - x4)) / d, u = -((x1 - x2) * (z1 - z3) - (z1 - z2) * (x1 - x3)) / d;
  return t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6 ? null : [x1 + t * (x2 - x1), z1 + t * (z2 - z1)]; }

function build(o, typeOf /* {EXT:{kind,spacing_in,...}, INT:{...}} */) {
  const walls = wallList(o), H = o.height;
  const anyPlate = typeOf.EXT.kind === "plate" || typeOf.INT.kind === "plate";
  const n = anyPlate ? Math.max(1, Math.ceil(H / o.mesh - 1e-9)) : 1;
  const levels = Array.from({ length: n + 1 }, (_, k) => H * k / n);
  walls.forEach((w, i) => { w.len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]); const bp = [0, w.len];
    walls.forEach((v, j) => { if (i === j) return;
      for (const p of [v.a, v.b]) { const t = segParam(w, p); if (t !== null) bp.push(t); }
      const x = intersect(w, v); if (x) { const t = segParam(w, x); if (t !== null) bp.push(t); } });
    w.breaks = uniq(bp); });
  const nodes = new Map(), members = new Map(), plates = [];
  const key = (x, y, z) => [x, y, z].map(v => v.toFixed(4)).join(",");
  const node = (x, y, z) => { const k = key(x, y, z); if (!nodes.has(k)) nodes.set(k, { x, y, z }); return k; };
  const mem = (a, b, layer, set) => { if (a === b) return; const k = [a, b].sort().join("|"); if (!members.has(k)) members.set(k, { n1: a, n2: b, layer, set }); };
  const at = (w, t) => [w.a[0] + (w.b[0] - w.a[0]) * t / w.len, w.a[1] + (w.b[1] - w.a[1]) * t / w.len];
  for (const w of walls) { const ty = typeOf[w.set], layer = SETS[w.set].label;
    if (ty.kind === "plate") { const ts = [];
      for (let i = 0; i < w.breaks.length - 1; i++) { const t0 = w.breaks[i], t1 = w.breaks[i + 1], m = Math.max(1, Math.ceil((t1 - t0) / o.mesh - 1e-9));
        for (let k = 0; k < m; k++) ts.push(t0 + (t1 - t0) * k / m); }
      ts.push(w.len);
      for (let i = 0; i < ts.length - 1; i++) { const p0 = at(w, ts[i]), p1 = at(w, ts[i + 1]);
        for (let j = 0; j < levels.length - 1; j++) { const y0 = levels[j], y1 = levels[j + 1];
          plates.push({ n: [node(p0[0], y0, p0[1]), node(p1[0], y0, p1[1]), node(p1[0], y1, p1[1]), node(p0[0], y1, p0[1])], layer, set: w.set }); } }
    } else { const s = ty.spacing_in / 12, reg = [];
      for (let t = 0; t < w.len - 1e-6; t += s) reg.push(t);
      const ts = uniq([...w.breaks, ...reg.filter(t => w.breaks.every(b => Math.abs(b - t) > 0.25))]);
      for (const t of ts) { const p = at(w, t), jn = w.breaks.some(b => Math.abs(b - t) < 1e-4), ys = jn ? levels : [0, H];
        for (let j = 0; j < ys.length - 1; j++) mem(node(p[0], ys[j], p[1]), node(p[0], ys[j + 1], p[1]), layer, w.set); }
      for (let i = 0; i < ts.length - 1; i++) { const p0 = at(w, ts[i]), p1 = at(w, ts[i + 1]);
        for (const y of [0, H]) mem(node(p0[0], y, p0[1]), node(p1[0], y, p1[1]), layer + "_TRACK", w.set); } } }
  const keys = [...nodes.keys()].sort((a, b) => { const A = nodes.get(a), B = nodes.get(b); return A.y - B.y || A.z - B.z || A.x - B.x; });
  return { nodes, keys, members: [...members.values()], plates };
}

function toDXF(m, which = "ALL") { const L = [], p = (...a) => L.push(...a.map(String)), keep = s => which === "ALL" || which === s;
  const layers = [["EXTERIOR_WALLS", 4], ["EXTERIOR_WALLS_TRACK", 4], ["INTERIOR_WALLS", 30], ["INTERIOR_WALLS_TRACK", 30]];
  p("0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "2", "0", "ENDSEC");
  p("0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", layers.length);
  for (const [n, c] of layers) p("0", "LAYER", "2", n, "70", "0", "62", c, "6", "CONTINUOUS");
  p("0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES");
  const N = k => m.nodes.get(k), f = v => +v.toFixed(4);
  for (const e of m.members) { if (!keep(e.set)) continue; const a = N(e.n1), b = N(e.n2);
    p("0", "LINE", "8", e.layer, "10", f(a.x), "20", f(a.y), "30", f(a.z), "11", f(b.x), "21", f(b.y), "31", f(b.z)); }
  for (const pl of m.plates) { if (!keep(pl.set)) continue; p("0", "3DFACE", "8", pl.layer);
    pl.n.forEach((k, i) => { const v = N(k); p(10 + i, f(v.x), 20 + i, f(v.y), 30 + i, f(v.z)); }); }
  p("0", "ENDSEC", "0", "EOF"); return L.join("\r\n") + "\r\n"; }

function toNodeCSV(m) { return ["Label,X [ft],Y [ft],Z [ft],Temp [F],Detach From Diaphragm",
  ...m.keys.map((k, i) => { const v = m.nodes.get(k); return `N${i + 1},${+v.x.toFixed(4)},${+v.y.toFixed(4)},${+v.z.toFixed(4)},0,`; })].join("\r\n") + "\r\n"; }
```

## Verification snippet (Python)

```python
import ezdxf
from collections import Counter
d = ezdxf.readfile("Model_Walls.dxf")
print(Counter((e.dxftype(), e.dxf.layer) for e in d.modelspace()))
```

## Lessons learned

- RISA expects a vertical axis on import. Build Y-up and tell the user not to rotate.
- Separate exterior and interior DXFs are the dependable way to assign different properties.
- Artifact downloads can't save `.dxf`. Package as `.zip`, or offer copy-to-clipboard.
- Area-based wall placement can land a wall slightly off-grid (6" at grid C here). Call it out instead of snapping to the grid.
