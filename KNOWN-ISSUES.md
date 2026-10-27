# Known issues

What we know needs fixing or checking, as of 2026-10-27 4:12 PM. Put your name on one before you start, so two people don't fix the same thing.

| # | Issue | Where | Suggested fix | Owner |
|---|---|---|---|---|
| 1 | **Truss path doesn't pass the drawing.** The project's sheet never reaches Truss to RISA, because it's a separate claude.ai page and a browser can't hand it a file. | `mg/generate.js` (truss hand-off) | Short term: show the sheet on the Truss page, add a **Download this sheet** button and numbered steps. Long term: bring the truss tool's code into the repo with a clean template, so it opens the project's drawing directly. | Sam? / Olu |
| 2 | **"Read drawing with Claude" in the truss tool may not work for other viewers.** | Truss to RISA (claude.ai) | Olu to check on the claude.ai page. If the code moves into the repo, the drawing read would come from Afshin's app instead. | Olu |
| 3 | **The `.r3d` files haven't been opened in real RISA yet** (2D Frame, 3D Building, columns only). Node, member and combination counts match Chandler's Model 1 and Model 3. | `Final Models/`, `generate.html` | Open one of each in RISA-3D and note any import errors. | Chandler |
| 4 | **Design Criteria buttons on New Project are placeholders** (Building Code, Load Cases, Load Combinations, Seismic Design all say "Not set"). The generators already apply ASCE 7-22 ASD combinations. | `new-project.html` | Show what each generator applies, or open the inputs on the workspace page. | |
| 5 | **3D Building with more than one story** builds one level of columns and roof framing. The page says so. | `Final Models/roof-framing.js` | Repeat the level per story in the generator, or send multi-story projects to Afshin's app. | |
| 6 | **Projects are saved in each person's own browser.** They aren't shared between teammates or devices. | `mg/store.js` | Fine for the demo. Sharing would need a backend. | |
| 7 | **Three RISA templates and `Concept Plan.pdf` are held out of the repo.** The templates carry RISA or firm emails, and the PDF may be a real project. | Afshin's app, Philip's skill, the truss tool | Confirm with the organizers whether they handed these out. Chandler's generators already use a clean template, so Afshin's app could switch to his `r3d.py`. | Afshin |
| 8 | **Afshin's app needs a RISA template to export.** Its template is held back (see 7). | `app/risa_r3d.py` | Use Chandler's clean template, or his `r3d.py`, for export. | Afshin |
| 9 | **Afshin's app requirements aren't pinned** and haven't been installed and run on a clean PC. | `app/requirements.txt` | Run it once on a fresh machine and pin the versions that work. | Afshin |
| 10 | **Two copies of the home screen.** The live pages are at the repo root. Chandler's originals are in `Web Page/`. | `index.html`, `new-project.html`, `Web Page/` | Edit the root files. Keep or retire `Web Page/` once Chandler confirms. | Chandler |
| 11 | **One table on the team notes page scrolls sideways on phones.** All other pages fit. | `team.html` | Let the table scroll inside its own box. | |
| 12 | **Three copies of the W-shape table** (Afshin, Philip, Chandler). | `app/templates/`, `.claude/skills/floor-plan-columns/assets/`, `Final Models/` | Agree on one source later. Not needed for the demo. | |

## Fixed today

- Chandler's home screen is the site root, and New Project uploads, saves and routes to each tool.
- 2D Frame and 3D Building build a `.r3d` in the browser from Chandler's generators.
- The browser tracer opens a project's own sheet.
- README describes the whole project.
