# Sketch to RISA

A browser app that turns a PDF drawing or a photo of a hand sketch into a starting RISA-3D model. Built at the NCSEA Big Build SE Hackathon, 2026-10-27.

It runs entirely in the browser. Nothing is uploaded anywhere.

## How it works

1. **Open** a PDF page or an image (photo or scan of a sketch).
2. **Set scale:** click both ends of a known dimension and type its length (`24'-6"`, `7.5`, `2.5m`).
3. **Draw members:** click node to node. Clicks snap to existing nodes. Hold Shift to lock horizontal or vertical.
4. **Find lines (auto-detect):** drag a box around the framing, or click once for the whole sheet. Suggested members show dashed. Remove extras (dimension lines, ground lines) with Delete, then Accept. Accept joins ends that nearly meet and adds nodes where lines cross, so beams and columns connect. The slider sets the shortest line to keep.
5. **Supports:** click a node to cycle Pinned, Fixed, Roller, none.
6. **Export:**
   - **Copy nodes / members / supports** puts tab-separated rows on the clipboard. Paste them into the matching RISA-3D spreadsheet (Nodes, Members, Boundary Conditions).
   - **Download DXF** writes members as LINE entities on layer `MEMBERS`, in feet. Import it in RISA-3D with File > Import > DXF.
   - **Download CSV** writes all three tables to one file.

Coordinates use the lowest, leftmost node as the origin. Elevation view exports X and Y (Y up). Plan view exports X and Z.

## Run locally

It's plain HTML, CSS and JavaScript with no build step. Serve the folder with any static server:

```bash
python -m http.server 8080
```

Then open http://localhost:8080.

## Deploy

GitHub Pages: Settings > Pages > Deploy from a branch > `main` / root.

## How line detection works

`detect.js`, plain JavaScript with no libraries:

1. Adaptive threshold (Bradley and Roth, 2007) separates ink from paper, even under uneven photo lighting.
2. Zhang-Suen thinning (1984) reduces strokes to 1 px center lines.
3. Hough transform (Duda and Hart, 1972) finds the strongest straight line, splits the ink along it into continuous runs, keeps long dense runs and repeats.
4. Cleanup merges broken pieces of one line, squares up near-horizontal and near-vertical lines, and joins ends at corners and T's.

## Samples

- `samples/portal-frame.svg`: a clean gable frame drawing (40'-0" span).
- `samples/hand-sketch.jpg`: a two-bay, two-story braced frame drawn like a pencil sketch photo. Regenerate it with `python tools/make_sketch.py samples/hand-sketch.jpg` (needs Pillow).

## Libraries

- [PDF.js](https://mozilla.github.io/pdf.js/) 3.11.174 (Apache 2.0), loaded from cdnjs.

## Note

This tool helps an engineer build a starting model faster. The engineer checks every coordinate, connection and support in RISA and owns the design.

## Ideas next

- Snap detected nodes to grid lines so hand-drawn wobble rounds out.
- Read grid lines and dimension text from vector PDFs.
- Section assignment per member.
