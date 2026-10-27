---
name: sketch-to-risa-dev
description: How the Sketch to RISA web app is built and how to change it safely. Use when adding a feature, fixing a bug, changing line detection or RISA export, adding a sample, or running and testing the app locally.
---

# Working on Sketch to RISA

Added by: Kei (@khkusakabe)

## Shape of the repo
The team app (Afshin's) lives at the repo root; see `HOSTING.md`. The first prototype described below lives in `prototype/`, so the paths below are relative to it. `team.html`, `team.json` and `.claude/` stay at the root.

Plain HTML, CSS and JavaScript, no build step, served by GitHub Pages from `main` (every merge goes live).

| File | Owns |
|---|---|
| `index.html` | Layout and controls |
| `app.js` | Model, canvas drawing, input, scale, supports, accepting suggestions |
| `detect.js` | `LineDetect.detect(canvas, rect, {minFrac})` -> `{segments, tol}` in drawing pixels |
| `export.js` | `RisaExport` pure functions: `table`, `tsv`, `csv`, `dxf`. A teammate owns RISA export, so coordinate before changing it |
| `team.html`, `team.json` | Team notes page and roster |

Model: nodes `{id, x, y, support}` in drawing pixels (y down), members `{id, i, j}`, and `ftPerPx` to convert to feet.

## Run and test
- `python -m http.server 8080`, then open http://localhost:8080/prototype/.
- `samples/hand-sketch.jpg`: set scale 25' between the first two column bases, then Find lines with one click. Expect 7 lines. Delete the ground line, then Accept gives 9 nodes and 11 members.
- `samples/portal-frame.svg`: Find lines gives 6 members plus the dimension line.
- Check the browser console for errors after any change.

## Rules
- Keep it buildless. A library loads from cdnjs at a pinned version.
- Public sources only. Cite the method in a comment.
- Nothing from anyone's employer.
- The tool assists the engineer: never call a result acceptable, approved or compliant.
- Branch per task, small commits, pull request into `main`.

## Final step, every run: native RISA-3D file (.r3d)

Added by: Chandler (@chandlerTKJSE)

After the DXF and CSV export, write a native `.r3d` input file for the same model with `r3d.py` in this folder. The script follows RISA-3D Help, Appendix D, File Format (help.risa.com). This touches RISA export, so tell the export owner about any change.

1. Build a model dict from the exported model:
   - `nodes`: `(label, x, y, z)` in feet
   - `bcs`: boundary conditions per node, as `"Reaction"`, `"Fixed"` or `""`
   - `materials`: hot-rolled labels, `A992` or `A500 Gr.C`
   - `secsets`: `(label, shape, design list, member type, material, A, Iyy, Izz, J)`
   - `members`: `(label, i, j, rotation, section set)`
2. Call `write_r3d(model)` and save the result as `<Model>.r3d` with CRLF line endings. Deliver it with the DXF and CSVs.

Conventions:

- **Labels:** use the sketch labels as section sets. RISA member labels must be unique, so number the members within each set (C1-1, C1-2, …).
- **HSS names:** RISA writes HSS wall thickness in sixteenths (HSS5X5X3/8 becomes HSS5X5X6). `risa_shape()` does this.
- **Section properties:** Iyy is the weak axis and Izz the strong axis.
- **Boundary codes:** 4 = Reaction, 1 = Fixed, 0 = Free. Nodes are numbered from 1 in file order.

Not written:

- Loads and load combinations, because Appendix D does not document their syntax. Keep them in the CSVs.
- `[GLOBAL_PARAMETERS]`, `[SHAPES_LIST]`, `[DATA_INTEGRITY_KEY]` and `[KEYID]`.
- Member end releases, which are written as 0 (none) because Appendix D gives no code table for them.

The engineer opens the `.r3d` in RISA and checks geometry, sections and supports. If RISA rejects the file, the DXF and CSVs are the fallback.
