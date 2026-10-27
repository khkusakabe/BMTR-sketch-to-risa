---
name: sketch-to-risa-dev
description: How the Sketch to RISA web app is built and how to change it safely. Use when adding a feature, fixing a bug, changing line detection or RISA export, adding a sample, or running and testing the app locally.
---

# Working on Sketch to RISA

Added by: Kei (@khkusakabe)

## Shape of the app
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
- `python -m http.server 8080`, then open http://localhost:8080.
- `samples/hand-sketch.jpg`: set scale 25' between the first two column bases, then Find lines with one click. Expect 7 lines. Delete the ground line, then Accept gives 9 nodes and 11 members.
- `samples/portal-frame.svg`: Find lines gives 6 members plus the dimension line.
- Check the browser console for errors after any change.

## Rules
- Keep it buildless. A library loads from cdnjs at a pinned version.
- Public sources only. Cite the method in a comment.
- Nothing from anyone's employer.
- The tool assists the engineer: never call a result acceptable, approved or compliant.
- Branch per task, small commits, pull request into `main`.
