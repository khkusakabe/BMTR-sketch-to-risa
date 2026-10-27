# Working on Sketch to RISA

Start with the team notes page: https://khkusakabe.github.io/BMTR-sketch-to-risa/team.html (source: `team.html`). It covers what's done, how the code fits together, and the open tasks.

## Quick version

1. Send Kei your GitHub username to get a collaborator invite.
2. Clone, then run `python -m http.server 8080` and open http://localhost:8080. There's no build step.
3. Pick an open issue and assign yourself.
4. Work on a branch (`git switch -c <task>`), commit small, and open a pull request.
5. `main` is the live site. Every merge to `main` goes live within a minute or two, so keep it working.

## Add yourself and your skills

- **Roster:** add an entry to `team.json` with your name, GitHub username, skills and what you're working on. It shows on the team page. The pencil icon on GitHub works fine.
- **Claude Code skills:** add `.claude/skills/<skill-name>/SKILL.md`. See `.claude/skills/README.md` for the template. Everyone who opens the repo in Claude Code gets it.

## Who owns what

- `export.js` (RISA export) has an owner. Coordinate with them before changing it.
- Line detection is in `detect.js`. The rest of the app is in `app.js`.

## Ground rules

- Plain HTML, CSS and JavaScript. If you add a library, load a pinned version from cdnjs.
- Public sources only. Name the paper or doc a method comes from in a comment.
- Nothing from your employer: no internal code, templates, standards or project data.
- The tool assists an engineer and shows its work. Don't describe results as acceptable, approved or compliant.
