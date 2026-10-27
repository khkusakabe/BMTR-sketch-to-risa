# Known issues

What we know needs fixing or checking, as of 2026-10-27 4:12 PM. Put your name on one before you start, so two people don't fix the same thing.

| # | Issue | Where | Suggested fix | Owner |
|---|---|---|---|---|
| 1 | **Truss tool doesn't open the project's drawing by itself.** It's now in the repo (`truss/`), and the Truss page offers **Download sheet** plus steps, but you still upload the sheet into it by hand. | `truss/index.html`, `mg/generate.js` | Load the project's sheet into the tool on open (needs a small hook in its drawing loader). | Olu |
| 2 | **"Read drawing with Claude" only works on Olu's own claude.ai screen.** It uses the artifact's Claude sampling, which claude.ai doesn't grant to other viewers, so they see "Claude isn't available in this view". On our site it's off for the same reason. Templates, straightening, editing and export work everywhere. | Truss to RISA | Olu: republish the artifact so viewers can use their own Claude. On our site, read drawings with Afshin's app or trace the nodes by hand. | Olu |
| 3 | **The `.r3d` files haven't been opened in real RISA yet** (2D Frame, 3D Building, columns only). Node, member and combination counts match Chandler's Model 1 and Model 3. | `Final Models/`, `generate.html` | Open one of each in RISA-3D and note any import errors. | Chandler |
| 4 | **Design Criteria buttons on New Project are placeholders** (Building Code, Load Cases, Load Combinations, Seismic Design all say "Not set"). The generators already apply ASCE 7-22 ASD combinations. | `new-project.html` | Show what each generator applies, or open the inputs on the workspace page. | |
| 5 | **3D Building with more than one story** builds one level of columns and roof framing. The page says so. | `Final Models/roof-framing.js` | Repeat the level per story in the generator, or send multi-story projects to Afshin's app. | |
| 6 | **Projects are saved in each person's own browser.** They aren't shared between teammates or devices. | `mg/store.js` | Fine for the demo. Sharing would need a backend. | |
| 7 | **Two RISA templates and `Concept Plan.pdf` are held out of the repo.** The templates carry RISA staff emails, and the PDF may be a real project. (The truss tool's template is in, with its email blanked.) | Afshin's app, Philip's skill | Confirm with the organizers whether they handed these out. Chandler's generators already use a clean template, so Afshin's app could switch to his `r3d.py`. | Afshin |
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
- Truss to RISA is in the repo (`truss/`), with its firm email removed from the template and browser downloads for Save and Export.
