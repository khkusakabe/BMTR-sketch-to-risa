---
name: sketch-to-risa-moment-frame
description: Turn a hand sketch of a 2-D steel moment frame into a RISA-3D importable DXF (layers = section sets) plus node, member, load case and ASCE 7-22 ASD combination CSVs, with a web app for W-shape selection and load inputs.
---

# Sketch → RISA: 2-D Moment Frame

Turn a photo of a hand-drawn 2-D frame into the following:

- a **DXF** for RISA-3D import, with one layer per section set
- **CSV tables** for nodes, members, basic load cases and ASD load combinations
- a **web app** that opens with a redrawn model and has W-shape dropdowns, load inputs, and ASCE 7-22 ASD combinations

## Sketch nomenclature (applies to every sketch)

| Mark on sketch | Meaning in model |
|---|---|
| Pen-drawn (blue) lines | Members. **Ignore** the paper's printed ruled lines. |
| Shaded triangle at a beam end | **Fixed (moment) connection**: no end release |
| Horizontal line over diagonal hatch at a column base | **Fixed base**: all six DOF are reactions |
| Coordinate axis sketched in a corner | Global axes to use (e.g. X right, Y up) |
| Label on a member (C1, B1, B2 …) | Section set name |
| Size table at the bottom (`C1 = W12X35`) | Shape assigned to that section set. A crossed-out size is void; use the replacement written beside it. |
| Dimension strings | Geometry, in feet |

## Procedure

### 1. Read the sketch

- Convert the photo before reading it. HEIC → PNG with `pillow-heif` and `ImageOps.exif_transpose`, downsized to about 2000 px.
- Record the following:
  - the axes
  - every pen-drawn member and its label
  - the connection marks at each beam end
  - the base marks
  - the dimension strings
  - the size table
- If a mark or size is unreadable, state your reading in the reply (e.g. "B1 = W12X22; W16X26 was struck") instead of guessing silently.

### 2. Build the geometry (units: ft)

- Define nodes at the base, at each beam level, and at each column line.
- Each column is **one continuous LINE** from base to top. RISA makes it a physical member, with internal nodes wherever beams frame in, so the sketch's single member label is preserved.
- Each beam is one LINE between its column nodes.
- Member labels must be unique in RISA. When the sketch reuses a label (two "C1" columns), keep the label as the **section set** and number the members `C1-1`, `C1-2`, ….
- **2-D frame in RISA-3D:** the frame lies in the X-Y plane at Z = 0. Restrain Z, MX and MY at the non-base nodes so it stays planar.

### 3. Write the DXF

- R12 ASCII (`AC1009`), with `$INSUNITS = 2` (feet) and CRLF line endings.
- One LAYER per section set, using the sketch label (C1, B1, B2 …).
- Members are `LINE` entities. Don't add TEXT or point entities.

### 4. Write the companion CSVs

- **Nodes:** `Label, X, Y, Z, X…MZ Bound`
  - fixed bases: `Reaction` in all six DOF
  - other nodes: Z, MX and MY restrained
- **Members:** `Label, I Node, J Node, Section Set, Shape, Material (A992), I/J Release`. Fixed connections get no release.
- **Basic load cases:**

  | BLC | Load case | Category | How it is applied |
  |---|---|---|---|
  | 1 | Dead | DL | Uniform on beams, plus self-weight (Y gravity −1) |
  | 2 | Live | LL | Uniform on beams |
  | 3 | Wind +X | WLX | Joint loads at the left node of each level |
  | 4 | Seismic QE +X | ELX | Joint loads Fx from Cs |

- **ASD combinations:** `Label, Description, BLC/Factor pairs`.

### 5. Seismic (ELF, ASCE 7-22 §12.8)

- Base shear: `V = Cs · W`, where W = Σ wₓ. By default wₓ = D (klf) × span, and the user can override it.
- Vertical distribution: `Fx = Cvx · V` and `Cvx = wₓhₓᵏ / Σ wᵢhᵢᵏ` (Eq. 12.8-11, 12.8-12). The default k = 1.0 applies for T ≤ 0.5 s.
- `Eh = ρ·QE`, applied as the factor on BLC 4.
- `Ev = 0.2·S_DS·D`, folded into the Dead factor.

### 6. ASCE 7-22 ASD combinations (§2.4.1, §2.4.5)

Lr, S and R are not modeled, so combination 3 equals combination 1 and is omitted. Lateral loads run in ±X.

| Combo | Equation | D | L | W | QE |
|---|---|---|---|---|---|
| 1 | D | 1 | | | |
| 2 | D + L | 1 | 1 | | |
| 4 | D + 0.75L | 1 | 0.75 | | |
| 5a/b | D ± 0.6W | 1 | | ±0.6 | |
| 6a/b | D + 0.75L ± 0.75(0.6W) | 1 | 0.75 | ±0.45 | |
| 7a/b | 0.6D ± 0.6W | 0.6 | | ±0.6 | |
| 8a/b | 1.0D + 0.7Ev ± 0.7Eh | 1 + 0.14S_DS | | | ±0.7ρ |
| 9a/b | 1.0D + 0.525Ev ± 0.525Eh + 0.75L | 1 + 0.105S_DS | 0.75 | | ±0.525ρ |
| 10a/b | 0.6D − 0.7Ev ± 0.7Eh | 0.6 − 0.14S_DS | | | ±0.7ρ |

Confirm these factors against §2.4 of the user's copy of ASCE 7-22 before relying on them.

### 7. Web app (single self-contained HTML artifact)

1. **Opening view: the redrawn model** (SVG).
   - Members in pen color, with member labels and their current shapes.
   - A filled triangle in the joint corner at each fixed beam end.
   - A line with hatch at each fixed base.
   - Node labels, dimension strings, and the X/Y axis glyph as sketched.
2. **Members and section sets.** One dropdown per section set, listing all W-shapes sorted by depth then weight. Show wt, A, Ix, Zx, Iy and J. Changing a shape redraws the labels.
3. **Basic load case inputs:**
   - **Dead and Live:** klf, per beam.
   - **Wind:** k, per level. Enter strength-level W; the 0.6 factor is applied in the combinations.
   - **Seismic:** Cs, ρ, S_DS, k, and seismic weight per level. Show W, V, Fx and Cvx live.
4. **BLC table**, followed by the **ASD combination table** with factors per BLC.
5. **Export.**
   - The artifact `downloads` capability can't save `.dxf`, so package everything as a **.zip**: build a store-only zip with CRC32 containing the DXF and all CSVs.
   - Add "Copy DXF text" and "Copy combinations CSV" as fallbacks.
6. Inline the same generator code (below) and the W-shape data in the page, so the page and the files never diverge.

### 8. Verify, then deliver

- **DXF:** parse it with `ezdxf` and print each entity's layer and endpoints against the sketch dimensions.
- **Seismic:** hand-check Cvx (e.g. w = 16 k @ 15', 10 k @ 25' → Cvx = 240/490 = 0.490 and 0.510).
- **Scripts:** run `node --check` on the inlined scripts.
- **Deliver:** send the DXF and CSVs, and write them beside the sketch when the user's folder is connected.
- **Confidence:**
  - DXF geometry: high.
  - Combination factors: medium-high, so confirm them against §2.4.
  - RISA import behavior: confirm on the first import.

## AISC W-shape data

Extract the W rows from the `shapes_AISC.db` SQLite file inside the PyPI package `aiscpy`. That package is reachable even when other sites aren't. The result is 274 W shapes.

```bash
pip download --no-deps aiscpy -d pkgs
unzip -o pkgs/aiscpy-*.whl aiscpy/shapes_AISC.db -d ex
python3 -I -c "
import sqlite3, json
c = sqlite3.connect('ex/aiscpy/shapes_AISC.db')
q = 'select Shape,A,d,tw,bf,tf,\"wt./ft.\",Ix,Sx,Zx,Iy,Sy,Zy,J,rx,ry from \"W-M-S-HP_shapes_AISC\" where Type=\"W\"'
rows = [[r[0]] + [float(x) for x in r[1:]] for r in c.execute(q)]
open('wshapes.js', 'w').write('const W_SHAPES=' + json.dumps(rows, separators=(',', ':')) + ';')
"
```

Spot-check a few shapes before using the data: W12X35 has Ix = 285, W16X31 has Ix = 375, and W12X22 has Ix = 156.

## RISA import steps (tell the user)

1. File → Import → DXF. Set units to feet and the vertical axis to Y.
2. Set section sets C1, B1 and B2 to the chosen shapes (A992), then assign them by layer or by member.
3. Paste the node boundary conditions, the BLCs and the load combinations from the CSVs.
4. Run Model Merge, then solve.

## Example: Model 1 (from sketch)

- **Bay:** 20'-0".
- **Stories:** 15'-0" to Level 2 (B2), then 10'-0" to the roof (B1).
- **Shapes:** C1 = W12X35, B1 = W12X22 (W16X26 struck), B2 = W16X31.
- **Connections:** all beam connections fixed, both bases fixed.

## Reference implementation (`frame.js`, runs in Node and the browser)

Replace `FRAME` for a new sketch. Everything else is generic.

```js
// Model 1 — 2D moment frame. Units: ft, kips. RISA axes per sketch: X right, Y up.
const FRAME = {
  nodes: [
    ["N1", 0, 0], ["N2", 20, 0],
    ["N3", 0, 15], ["N4", 20, 15],
    ["N5", 0, 25], ["N6", 20, 25],
  ],
  // label, I, J, section set (sketch label). Columns are continuous physical members; B2 frames in at N3/N4.
  members: [
    ["C1-1", "N1", "N5", "C1"],
    ["C1-2", "N2", "N6", "C1"],
    ["B2", "N3", "N4", "B2"],
    ["B1", "N5", "N6", "B1"],
  ],
  fixedBases: ["N1", "N2"],
  levels: [{ name: "Level 2", beam: "B2", h: 15 }, { name: "Roof", beam: "B1", h: 25 }],
  span: 20,
  defaultShapes: { C1: "W12X35", B1: "W12X22", B2: "W16X31" },
};

function frameDXF() {
  const L = [], p = (...a) => L.push(...a.map(String));
  const N = Object.fromEntries(FRAME.nodes.map(([n, x, y]) => [n, [x, y]]));
  const layers = [["C1", 5], ["B1", 1], ["B2", 3]];
  p("0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "2", "0", "ENDSEC");
  p("0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", layers.length);
  for (const [n, c] of layers) p("0", "LAYER", "2", n, "70", "0", "62", c, "6", "CONTINUOUS");
  p("0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES");
  for (const [, i, j, set] of FRAME.members) {
    const a = N[i], b = N[j];
    p("0", "LINE", "8", set, "10", a[0], "20", a[1], "30", 0, "11", b[0], "21", b[1], "31", 0);
  }
  p("0", "ENDSEC", "0", "EOF");
  return L.join("\r\n") + "\r\n";
}

function nodesCSV() {
  const r = ["Label,X [ft],Y [ft],Z [ft],X Bound,Y Bound,Z Bound,MX Bound,MY Bound,MZ Bound"];
  for (const [n, x, y] of FRAME.nodes) {
    const fixed = FRAME.fixedBases.includes(n);
    // Bases fixed; all other nodes restrained out-of-plane (Z, MX, MY) for planar 2D behavior.
    const b = fixed ? ["Reaction", "Reaction", "Reaction", "Reaction", "Reaction", "Reaction"] : ["", "", "Reaction", "Reaction", "Reaction", ""];
    r.push([n, x, y, 0, ...b].join(","));
  }
  return r.join("\r\n") + "\r\n";
}

function membersCSV(shapes) {
  const r = ["Label,I Node,J Node,Section Set,Shape,Material,I Release,J Release"];
  for (const [l, i, j, set] of FRAME.members) r.push([l, i, j, set, shapes[set], "A992", "Fixed", "Fixed"].join(","));
  return r.join("\r\n") + "\r\n";
}

// ---- Loads ----
// inputs: { D:{B1,B2} klf, L:{B1,B2} klf, W:{Roof,Level 2} k, Ws:{Roof,Level 2} k (seismic weight), Cs, k, rho, SDS }
function seismic(inp) {
  const lv = FRAME.levels.map(l => ({ ...l, w: inp.Ws[l.name] }));
  const W = lv.reduce((a, l) => a + l.w, 0), V = inp.Cs * W;
  const den = lv.reduce((a, l) => a + l.w * Math.pow(l.h, inp.k), 0);
  lv.forEach(l => { l.Cvx = den ? (l.w * Math.pow(l.h, inp.k)) / den : 0; l.Fx = l.Cvx * V; });
  return { W, V, levels: lv };
}

function basicLoadCases(inp) {
  const s = seismic(inp);
  return [
    { n: 1, desc: "Dead", cat: "DL", sw: -1, loads: FRAME.levels.map(l => ({ type: "Member dist", m: l.beam, dir: "Y", mag: -inp.D[l.beam], unit: "klf" })) },
    { n: 2, desc: "Live", cat: "LL", sw: 0, loads: FRAME.levels.map(l => ({ type: "Member dist", m: l.beam, dir: "Y", mag: -inp.L[l.beam], unit: "klf" })) },
    { n: 3, desc: "Wind +X", cat: "WLX", sw: 0, loads: FRAME.levels.map(l => ({ type: "Joint", m: l.h === 25 ? "N5" : "N3", dir: "X", mag: inp.W[l.name], unit: "k" })) },
    { n: 4, desc: "Seismic QE +X", cat: "ELX", sw: 0, loads: s.levels.map(l => ({ type: "Joint", m: l.h === 25 ? "N5" : "N3", dir: "X", mag: +l.Fx.toFixed(3), unit: "k" })) },
  ];
}

// ASCE 7-22 ASD combinations, Sec. 2.4.1 (basic) and 2.4.5 (seismic). Lr, S, R not used in this model.
// Eh = rho*QE ; Ev = 0.2*SDS*D, folded into the D factor.
function asdCombos(inp) {
  const r = inp.rho, ev = 0.2 * inp.SDS;
  const f = v => +v.toFixed(4);
  const out = [];
  const add = (id, ref, eq, D, L, W, E) => out.push({ id, ref, eq, D: f(D), L: f(L), W: f(W), E: f(E) });
  add("1", "2.4.1 (1)", "D", 1, 0, 0, 0);
  add("2", "2.4.1 (2)", "D + L", 1, 1, 0, 0);
  add("4", "2.4.1 (4)", "D + 0.75L", 1, 0.75, 0, 0);
  for (const [s, sg] of [["+", 1], ["−", -1]]) add("5" + (sg > 0 ? "a" : "b"), "2.4.1 (5)", `D ${s} 0.6W`, 1, 0, 0.6 * sg, 0);
  for (const [s, sg] of [["+", 1], ["−", -1]]) add("6" + (sg > 0 ? "a" : "b"), "2.4.1 (6)", `D + 0.75L ${s} 0.75(0.6W)`, 1, 0.75, 0.45 * sg, 0);
  for (const [s, sg] of [["+", 1], ["−", -1]]) add("7" + (sg > 0 ? "a" : "b"), "2.4.1 (7)", `0.6D ${s} 0.6W`, 0.6, 0, 0.6 * sg, 0);
  for (const [s, sg] of [["+", 1], ["−", -1]]) add("8" + (sg > 0 ? "a" : "b"), "2.4.5 (8)", `1.0D + 0.7Ev ${s} 0.7Eh`, 1 + 0.7 * ev, 0, 0, 0.7 * r * sg);
  for (const [s, sg] of [["+", 1], ["−", -1]]) add("9" + (sg > 0 ? "a" : "b"), "2.4.5 (9)", `1.0D + 0.525Ev ${s} 0.525Eh + 0.75L`, 1 + 0.525 * ev, 0.75, 0, 0.525 * r * sg);
  for (const [s, sg] of [["+", 1], ["−", -1]]) add("10" + (sg > 0 ? "a" : "b"), "2.4.5 (10)", `0.6D − 0.7Ev ${s} 0.7Eh`, 0.6 - 0.7 * ev, 0, 0, 0.7 * r * sg);
  return out;
}

function combosCSV(inp) {
  const r = ["Label,Description,BLC,Factor,BLC,Factor,BLC,Factor,BLC,Factor"];
  for (const c of asdCombos(inp)) {
    const pairs = [[1, c.D], [2, c.L], [3, c.W], [4, c.E]].filter(([, v]) => v !== 0);
    const cells = pairs.flatMap(([b, v]) => [b, v]);
    while (cells.length < 8) cells.push("");
    r.push(["ASD " + c.id, '"' + c.eq.replace(/−/g, "-") + '"', ...cells].join(","));
  }
  return r.join("\r\n") + "\r\n";
}

function blcCSV(inp) {
  const r = ["BLC,Description,Category,Y Gravity (self-weight),Load Type,Member/Node,Direction,Magnitude,Units"];
  for (const b of basicLoadCases(inp)) for (const l of b.loads) r.push([b.n, b.desc, b.cat, b.sw || "", l.type, l.m, l.dir, l.mag, l.unit].join(","));
  return r.join("\r\n") + "\r\n";
}

if (typeof module !== "undefined") module.exports = { FRAME, frameDXF, nodesCSV, membersCSV, seismic, basicLoadCases, asdCombos, combosCSV, blcCSV };
```

## Lessons learned

- Restrain Z, MX and MY at non-base nodes, or a 2-D frame in RISA-3D is unstable out of plane.
- Keep sketch labels as section sets. RISA member labels must be unique.
- A continuous column line plus a physical member gives the beam-column joint node without splitting the member.
- `.dxf` is not an allowed artifact download extension, so ship a `.zip`.
