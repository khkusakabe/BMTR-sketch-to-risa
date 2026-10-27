# Sketch to RISA

**Team BMTR, NCSEA Big Build SE Hackathon, 2026-10-27.**

Turn a framing sketch, a PDF plan or a truss drawing into a starting RISA-3D model, instead of retyping every node and member.

**Live site: https://khkusakabe.github.io/BMTR-sketch-to-risa/**

## How it works

The home screen is the **Model Generator**. Start a project, upload the plan sheet, pick the system type, and it sends you to the right tool:

| System type | Tool | Runs |
|---|---|---|
| **2D Frame** | Moment Frame generator: **Read the sketch** with Claude to fill the bay, story heights, W-shapes, beam-end fixity and base, add loads, then download a `.r3d` | In the browser (sketch reading needs your Anthropic API key) |
| **3D Building** | Roof Framing generator: column grid plus roof beams (or columns only), loads by tributary area, then download a `.r3d` | In the browser |
| **2D Truss** | Truss to RISA: Fink, Howe/Pratt, flat-chord or mono templates, photo straightening, node editing, then export a `.r3d`. The Claude drawing reader runs on its claude.ai version | In the browser |
| **3D Misc Frame** | Browser tracer: **Read sketch** with Claude builds labeled members, supports and scale from the sheet; or find lines automatically or trace node to node; then export DXF or RISA spreadsheet rows | In the browser |

For reading a sketch or a PDF with Ai, the workspace also links:

- **Afshin's app:** a Claude agent reads a sketch photo or a PDF plan, checks its own drawing and revises, then writes a native `.r3d` and opens RISA-3D. Runs on your PC.
- **Philip's floor-plan-columns skill:** finds or lays out columns on a 1-story PDF plan, frames the roof, and writes a `.r3d` plus a Column web app. Runs in Claude Code.

The generators write RISA-3D v23 files with nodes, supports, AISC sections, members, basic load cases and ASCE 7-22 ASD load combinations. Each one has a built-in template with its account ID removed, or you can supply your own RISA-saved `.r3d` to keep your office's materials, codes and settings.

## The team's pieces

| Piece | Where | By |
|---|---|---|
| Model Generator home screen and New Project page | `index.html`, `new-project.html` (originals in `Web Page/`) | Chandler |
| RISA-3D generators: moment frame, foundation plan, roof framing | `Final Models/` | Chandler |
| Workflow guides: moment frame from a sketch, wall model from a floor plan | `sketch-to-risa-moment-frame.md`, `risa-wall-model-from-plan.md` | Chandler |
| Worked RISA packages: Model 1 moment frame, Model 3 column plan | `models/` | Chandler |
| `.r3d` writer from RISA's published file format | `.claude/skills/sketch-to-risa-dev/r3d.py` | Chandler |
| Sketch and PDF reader with a Claude agent, framing editor, RISA launcher | `app/` | Afshin |
| Floor-plan-columns Claude skill | `.claude/skills/floor-plan-columns/` | Philip Yu |
| Truss to RISA (with photo straightening) | `truss/`, and on [claude.ai](https://claude.ai/artifact/4N6NXAs1sMhQWdEN2XEZef) with the Claude drawing reader | Olu |
| Project workspace that ties it together, browser tracer with line detection | `generate.html`, `mg/`, `prototype/` | Kei |
| Team notes, roster and shared skills | `team.html`, `team.json`, `.claude/skills/` | Team |

## Repo map

```
index.html, new-project.html   Model Generator: projects home and New Project
generate.html, mg/             Project workspace: runs the generators, hands off to the other tools
Final Models/                  RISA-3D generators (plain JavaScript, browser or Node)
app/                           Afshin's local app (Python server, Claude agents, .r3d writer)
prototype/                     Browser tracer: line detection, hand tracing, DXF and spreadsheet export
truss/                         Olu's Truss to RISA
models/                        Worked RISA packages (Model 1, Model 3)
.claude/skills/                Shared Claude Code skills
tools.html, team.html          All tools page and team notes
Web Page/                      Chandler's original mockups
```

## Run it

- **Browser tools:** open the live site. No install. To run locally, serve the repo folder with any static server, for example `python -m http.server 8080`, then open http://localhost:8080.
- **Generators from the command line:** `node "Final Models/moment-frame.js" inputs.json out.r3d`. See the header of each file for its inputs.
- **Afshin's app:** see [`app/README.md`](app/README.md). It needs Python, a Claude login or API key, and RISA-3D.

Projects created on the site are saved in your own browser only. The one exception is **Read the sketch**: it sends the plan sheet image straight from your browser to the Anthropic API with your own API key, which is stored in your browser only (`mg/sketch-reader.js`). Claude reads the sketch with the Model Creator nomenclature: pen lines are members, a shaded triangle at a beam end is a fixed connection (otherwise pinned), line over hatch at a base is a fixed base, labels are section sets, the size table assigns shapes (struck sizes are void), and dimension strings give the geometry.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). To get push access, open a [join request](https://github.com/khkusakabe/BMTR-sketch-to-risa/issues/new?title=Add%20me%20to%20the%20repo) or send Kei your GitHub username.

## Sources

- RISA-3D file format: RISA-3D Help, Appendix D (help.risa.com).
- AISC Shapes Database (W and HSS properties).
- Load combinations follow ASCE 7-22 ASD. Check them against the standard before relying on them.
- Browser line detection: Bradley and Roth adaptive threshold (2007), Zhang and Suen thinning (1984), Hough transform (Duda and Hart, 1972).
- [PDF.js](https://mozilla.github.io/pdf.js/) 3.11.174 (Apache 2.0).

## Note

These tools help an engineer build a starting model faster. The engineer checks every member, size, load, connection and support in RISA and owns the design.
