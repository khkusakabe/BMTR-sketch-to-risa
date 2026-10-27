---
name: floor-plan-columns
description: Locate structural columns on a PDF floor plan of a 1-story building (or lay them out on the grid, hidden in walls), frame the roof with steel girders and beams, and deliver a RISA-3D model (.r3d with nodes, pinned supports, W-shape columns, girders and beams) plus an interactive "Column" web app to adjust layout rules, story height, framing and the column list and download the .r3d. Use whenever the user uploads an architectural or structural plan PDF and asks to find, place or lay out columns or posts, frame a roof, lay out girders or beams, or wants a RISA-3D model or structural DXF/CAD file, even if they just say "where should the columns go" or attach a plan with no other words. Works on CAD/Revit exports and scanned drawings.
---

# Floor plan columns + roof framing → RISA-3D model + "Column" app

Added by: Philip Yu

The user wants column **placement** and **steel roof framing** for a 1-story building, delivered as:
1. a **RISA-3D model (.r3d)**, sent in chat. It is written into the user's own RISA-3D template (`assets/risa_template.r3d`, saved from their RISA-3D), so it carries their version, units, vertical axis, codes and materials. A DXF is made only if the user asks (`--dxf`).
2. a **"Column" web app** (published artifact) prefilled from the plan, where they can change the layout rules, story height, column shape and framing, edit or add columns, and download the .r3d.

**Ask for the story height** (floor to top of roof steel) before writing the DXF, unless the user already gave it or the drawings state it. The columns rise to it and the roof framing sits at it. Ask with AskUserQuestion at the start, alongside any other question, offering a few typical heights (e.g. 14, 16, 18 ft) and letting them type their own. If the user is away and can't answer, use 14 ft and say so at the top of the reply.

Grid lines and dimension strings on the drawing are the guide: grid spacings in the model snap to the dimension strings (e.g. 30'-0", 39'-5"), and every column is positioned as an offset from a grid line.

**Find vs. lay out**
- Columns drawn on the plan are kept as drawn. Two kinds are recognized: small **circles** (pipe/HSS, often with a "COL." callout) and **steel W-shapes** drawn as an I or H outline (vector plans). Lines through a drawn column take its offset.
- Plans often show only some columns, or none. Every grid point the rules call for that has no drawn column gets one, laid out with the user's rules:
  1. a column at every grid intersection, plus evenly spaced extra columns so none is more than **40 ft** apart along a grid line;
  2. columns **aligned in straight lines**: every column on a row or column line shares one offset from its grid line (rows and lines stay straight, so girders and beams do too). Lines through a drawn column take that column's offset;
  3. the line offsets (each within **3 ft**) are chosen together to **conceal columns in walls**, keep them at least **6 in** clear of door and window openings, and stay close to the grid;
  4. a column that can't be hidden on its lines is **exposed** inside the building and flagged; one that would still sit in a door/window opening is flagged **"Blocks opening"** for the user to decide (never silently moved off its line, and never outside the building).

**Roof framing** (steel, at top of steel = story height)
- **Girders** span the **short direction**, column to column. The direction is chosen by comparing typical column spacing each way; on a 30 ft x 39'-5" bay they run along the 30 ft side.
- **Beams** span between adjacent girder lines, spaced evenly at **8 to 12 ft o.c.** (each bay split into the fewest equal spaces that keep within 12 ft), plus a beam on each column line, column to column.
- A bay that can't meet the 8–12 ft range is flagged; mention it.

**Optimization (on by default): lightest steel**
- Every girder and beam is sized with the lightest adequate W-shape (AISC table in the engine): Fy 50 ksi, LRFD 1.2D + 1.6Lr, roof DL 20 psf + Lr 20 psf + self-weight, deflection L/240 live and L/180 total. Beams are taken as braced by the deck; girders braced at each beam, with a 10% capacity allowance for lateral-torsional buckling instead of a full check.
- For each bay, every beam count in the 8–12 ft window is sized and the lightest is kept (bays are independent because a girder spans one bay).
- Both girder directions are compared. The short-direction rule stands unless the long direction is more than 3% lighter; report both totals either way.
- If the user gives other loads, pass `--dead` / `--live`. Sizes are preliminary, for layout decisions; say so, and note that final sizes and connections are by the engineer of record.

**Buildings with several grids (wings at an angle)**
Some buildings have wings whose grids are rotated relative to each other (e.g. a wing at 20°). Read each wing on its own grid, then combine:
- one `find_columns.py` run per wing, each with `--region-poly` (a polygon around that wing only, its bubbles included), `--rotate auto` (measures the wing's grid angle) and `--wing "West wing"`;
- one `column_tool.js` run with all the wing models; it lays out and frames each wing on its own grid and writes ONE DXF with every wing at its true angle and position, and ONE app with a tab per wing.
Run the `find_columns.py` passes one after another, not in parallel (each holds a large render in memory).

**Building footprint**
The building outline is traced from the walls. Grid points more than `--max-shift` outside it get no column (grid lines often run past the building to canopies or site features), and no column is ever placed outside it. The console lists the skipped grid points.

## Files
- `scripts/find_columns.py`: reads the PDF (circles, W-shape symbols, grid bubbles, "COL" callouts, scale, walls, openings, footprint) in the wing's grid frame and writes `model.json` plus check images.
- `scripts/wshape.py`: finds W-shape (I/H) column outlines in vector PDFs, even when the drawing is exploded into loose line segments.
- `scripts/column_tool.js`: runs the column layout and roof framing and writes `<plan>-columns.dxf`, `layout.json` and `Column.html` (the app, self-contained).
- `assets/column_engine.js`: the one line-aligned layout/framing/DXF/zip engine, shared by the app and the tool, so they always agree.
- `assets/column_app.html`: the app template.
- `scripts/dxf_check.py`: validates the DXF and draws it over the original plan (used for the visual check even when delivering .r3d: run column_tool with `--dxf` for the check).
- `scripts/r3d_check.py`: checks a .r3d for the errors RISA treats as fatal (record counts, label widths, node/shape references, unique labels and IDs, template sections intact).
- `assets/risa_template.r3d`: the user's RISA-3D template (one column and one beam record of every member section are cloned from it). If the user sends a new template, replace this file.
- `assets/aisc_w_shapes.csv`: AISC Shapes Database v15.0 W-shape properties, for shape records the template doesn't have.

## Workflow

### 1. Look at the sheet
```bash
pdftoppm -r 40 -png -f <page> -l <page> plan.pdf preview
```
Find the floor-plan drawing (sheets often also carry a site plan), its scale label, grid bubbles, dimension strings, any drawn columns, and the doors, windows and storefronts. Zoom where unsure (`pdfplumber`: `page.crop(bbox).to_image(resolution=400)`). For a multi-page PDF pick the floor plan by title; ask only if several qualify.

### 2. Read the plan into a model
```bash
pip install --break-system-packages -q pdfplumber pypdfium2 opencv-python-headless pytesseract
python scripts/find_columns.py plan.pdf --out results --page 1 --region x0,y0,x1,y1
```
- `--region`: PDF points from top-left (preview px × 72 / preview dpi) around the floor plan, its bubbles and dimensions; exclude other drawings and the title block. `--region-poly "x,y x,y ..."` gives any polygon instead (use it for one wing of a building).
- `--rotate auto` (or degrees, counter-clockwise on the sheet) when the grid is not square to the sheet; the console prints the angle used. `--wing "name"` labels the wing.
- The scale is read from the drawing area, else from the sheet's drawing title when the whole sheet has a single scale.
- `--scale "3/16in=1ft"` if the `Scale:` line says not determined or is wrong. No scale or no grid means no model; the console says which.
- `--keepout x0,y0,x1,y1` (PDF points, repeatable): an opening the script can't see. Thin-line plans often show storefronts or windows only as a note or dimension ("STOREFRONT 18'-0\"") on a plain wall line; mark each one.
- `--include x5` / `--exclude 3` correct which circles count as drawn columns.
- Check the `Model:` line: how many grid spacings matched dimension strings. A spacing marked "measured" didn't match any dimension; check it against the drawing.

### 3. Lay out, frame, and write the DXF and app
```bash
node scripts/column_tool.js results/model.json --out results --story-height <ft> --dxf
# (--dxf here only for the visual check in step 4; deliver the .r3d)
# several wings: node scripts/column_tool.js west/model.json east/model.json --out results --story-height <ft> --name <Project>
```
Options: `--column-shape W10X33` (AISC W-shape for every column in the RISA model; the roof framing is sized, columns are not), `--r3d other_template.r3d`, `--story-height` (ft, from the user; the tool warns if it's missing), `--max-spacing 40` (ft), `--max-shift 3` (ft), `--clearance 6` (in), `--dia 6` (column diameter, in), `--no-fill` (report drawn columns only; only if the user asks). Framing: `--beam-min 8` / `--beam-max 12` (ft), `--girder-dir auto|x|y` (auto = short direction; fixing it turns off the direction comparison), `--no-column-beams`, `--no-framing`. Optimization: `--dead 20` / `--live 20` (psf), `--no-flip` (never run girders the long way), `--no-optimize` (fewest beams in the window, still sized). If the user states different rules, pass them; they also become the app's starting values.

The console lists the steel total (lb and psf), each option the optimizer compared, each bay (girder length, beam span, beam spacing), the member size tally, and each girder with its size and the columns it connects. Read the warnings, including any member that needs a shape larger than the table holds.

### 4. Check — always
```bash
python scripts/dxf_check.py results/<plan>-columns.dxf results/model.json --png results/dxf_check.png
# several wings: pass the FIRST wing's model and the PDF to draw over the whole sheet
python scripts/dxf_check.py results/<name>-columns.dxf west/model.json --pdf plan.pdf --png results/dxf_check.png
```
Then the RISA file, which must print `r3d structure OK`:
```bash
python scripts/r3d_check.py results/<name>-columns.r3d --template assets/risa_template.r3d
```
The DXF check must print `Structure OK`. Then look at `dxf_check.png`, the DXF drawn over the original plan:
- grid lines and bubbles sit on the drawing's grid, and the bay dimensions match its dimension strings;
- drawn columns: every one matched (compare with the "COL" callouts and any I/H symbols), nothing extra;
- several wings: each wing's grid lines sit on the drawing's grid at its angle; no columns or framing outside the building (parks, parking, canopies);
- every grid intersection has a column (drawn or proposed) unless the user said otherwise; grid lines closer than 8 ft to a parallel one (e.g. B and B.1) count as one column line, and the console says which line got the columns;
- proposed columns: each inside a real wall (not a dimension line, casework or canopy line), and clear of doors, windows and storefronts. Fix with `--keepout` and rerun steps 2–3;
- exposed columns: confirm there's really no wall nearby;
- alignment: the console's "Column lines" list gives one offset per line; every column on a line must match it;
- "Blocks opening" columns: describe the conflict and offer options, e.g. moving that whole column line to a nearby pier (raise `--max-shift` or place by hand in the app), accepting an exposed column set back from the glazing, or a transfer beam; let the user choose;
- framing: girders run the short way between columns, beams fill every bay at 8–12 ft o.c., and no bay is left unframed (a row or column line missing a column leaves a gap; say so).

`walls_check.png` (green walls, orange openings, blue windows) explains why a column landed where it did.

### 5. Deliver
- Send the `.r3d` with SendUserFile (the `.dxf` too only if the user asked for it).
- Publish `Column.html` with the Artifact tool, `capabilities: {"downloads": true}`. The app's download saves a `.zip` containing the `.r3d`, because artifact downloads can't save `.r3d` directly; "Copy .r3d" copies the text. If no Artifact tool is available, send `Column.html` as a file instead.
- Reply briefly: column count (drawn / in wall / exposed), story height, girder direction and beam spacing, the steel total and the alternative the optimizer compared, typical member sizes, grid and scale, and anything to look at (exposed columns, bays outside 8–12 ft, keep-outs you added and why, any spacing not matched to a dimension).

## RISA-3D model contents
- Units, vertical axis, codes, materials and label widths come from the template (the user's: feet, kips, **Y vertical**). Plan X stays X; plan north becomes -Z when Y is vertical.
- **Nodes**: each column base (Y=0) and top (story height), girder and beam ends at roof level. Beam ends sit on the girders; girders are physical members, so RISA connects them.
- **Supports**: every column base **pinned** (cloned from the template's support record: X, Y, Z translations restrained, rotations free).
- **Members**: columns (C1…), girders (G1…), beams (B1…) with the wing prefix when several wings (WES-C1…); records cloned from the template's column and beam rows, a new unique ID each; shapes are the optimizer's W-sizes for girders and beams and `--column-shape` for columns.
- **Shapes list**: the template's records, plus AISC-built records for any other W-shape used (all 24 values computed from AISC data; RISA's stored rT can differ by a few percent from the computed one).
- **Not set**: member end releases (RISA reads members as rigidly connected; apply BenPIN shear releases to girders and beams in RISA for simple-span framing), loads and load combinations, diaphragms. Say so when delivering.

## DXF contents, when asked for (R12 ASCII, inches, origin at the bottom-left grid intersection, Y up)
| Layer | Content |
|---|---|
| S-GRID | grid lines (dashed) |
| S-GRID-IDEN | grid bubbles and labels |
| S-ANNO-DIMS | bay and overall grid dimensions |
| A-WALL-REF | walls traced from the PDF, for reference |
| S-COLS | drawn (existing) columns, 2D symbol (circle, or I/H outline for W-shapes) |
| S-COLS-NEW | proposed or hand-placed columns, 2D symbol |
| S-COLS-IDEN | column tags C1… ("(EXPOSED)" where flagged) |
| S-COLS-3D | each column extruded to the story height (circle, or W-shape outline) |
| S-FRAM-GIRD | girders, column to column, at Z = story height |
| S-FRAM-BEAM | beams between girders, at Z = story height |
| S-FRAM-IDEN | girder tags (mark, size, span), beam sizes, beam spacing per bay, notes: top of steel, design loads, steel total, "for layout only" |

## The app ("Column")
- Layout rules (max spacing, max shift, opening clearance) re-run the layout live; column diameter feeds the DXF.
- Building: story height (sets the 3D column height and the framing elevation).
- Roof framing: on/off, girder direction (auto = short), beam spacing min/max, beams on column lines, optimize for lightest steel, allow the long direction, roof dead/live load. It shows the steel total, the options compared, the member size tally, and a bay table, with out-of-range bays flagged.
- Column list: reference grid line and offset in inches for X and Y. Editing a proposed row turns it into "Placed by hand", which stays put when the layout re-runs; removing one keeps it removed.
- Plan preview over the original drawing, with walls and openings toggles; grid spacing can be edited.
- Several wings: a tab per wing; story height and column shape apply to the whole building; the download is one .r3d with all wings; the framing panel shows the whole-building steel total.
- Column shape picker (all AISC W-shapes) for the RISA model's columns.
- The viewer's edits are kept in their own browser only. If the user wants a change made permanent, update the model or options here and republish the same file.

## Limitations to mention when relevant
- Drawn columns are found only if circular; other symbols need locating by inspection and adding with `--include` or in the app.
- Walls are read as parallel-line pairs or solid fill square to the wing's grid; walls at other angles within a wing aren't.
- At small scales (3/32" and smaller) partitions are only a few pixels wide and the opening detector over-flags; treat "Blocks opening" there as "check this one".
- W-shape symbols are found in vector PDFs only.
- Storefronts and windows drawn as a single line need `--keepout`.
- "COL" callouts are read from vector text only; check scans more carefully.
- Member sizes are preliminary (flexure and deflection only; no shear, LTB approximated, no connections, no drift/ponding/snow drift, no lateral system). Girders and beams are drawn as centerlines at top of steel.
