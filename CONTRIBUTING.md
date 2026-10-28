# Contributing to Sketch to RISA

This started as a one-day hackathon prototype (team BMTR, NCSEA Big Build SE Hackathon, 2026-10-27). Ideas, bug reports and fixes are welcome.

## How to help

1. Look at [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) or open an issue describing what you see.
2. Fork the repo, make a branch, and send a pull request.
3. To run it locally, serve the repo folder with `python -m http.server 8080` and open http://localhost:8080. There's no build step.
4. `main` is the live site, so keep it working.

## Where things are

- The project workspace is `generate.html` and `mg/`. The RISA-3D generators are in `Final Models/`.
- In the tracer, line detection is in `prototype/detect.js` and the rest is in `prototype/app.js`.
- Claude Code skills go in `.claude/skills/<skill-name>/SKILL.md`. See `.claude/skills/README.md` for the template.

## Ground rules

- Plain HTML, CSS and JavaScript in the browser tools. If you add a library, load a pinned version from cdnjs.
- Public sources only. Name the paper or doc a method comes from in a comment.
- Nothing from your employer: no internal code, templates, standards or project data.
- No personal details. Before adding a RISA file, open it in a text editor and clear COMPANY_NAME, DESIGNER_NAME and CLOUDID, which RISA fills from your own PC and account.
- The tools assist an engineer and show their work. Don't describe results as acceptable, approved or compliant.
