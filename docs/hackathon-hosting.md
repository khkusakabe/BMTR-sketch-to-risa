# Hosting the team app

> **Update, 2026-10-27 2:20 PM:** Afshin's app is a local Python server (case 3C below), so it lives in `app/` with its own run guide (`app/README.md`). The site root is a landing page linking to it and to the browser prototype. The rest of this page is kept for reference.

Afshin's app is becoming the team app. It goes at the root of this repo and is served by GitHub Pages at:

**https://khkusakabe.github.io/BMTR-sketch-to-risa/**

The first prototype has moved to `prototype/` and stays live at `/prototype/`. Until your app lands, the root page forwards there.

## 1. Get access

1. Send Kei your GitHub username.
2. Accept the invite from the email, or at https://github.com/khkusakabe/BMTR-sketch-to-risa/invitations.

## 2. Find your case

| Your app is... | GitHub Pages can host it? | Go to |
|---|---|---|
| Plain HTML, CSS and JavaScript (no build step) | Yes, as is | 3A |
| Built with a tool (React, Vite, Vue, Svelte, Next static export...) | Yes, with a small workflow file | 3B |
| Runs a server (Python, Flask, Streamlit, Node API) or calls an Ai API with a secret key | No, Pages only serves files | 3C |

## 3A. Plain HTML, CSS and JavaScript

```bash
git clone https://github.com/khkusakabe/BMTR-sketch-to-risa.git
cd BMTR-sketch-to-risa
git switch -c afshin-app
```

1. Replace the root `index.html` (it's only a forwarding page) with your app's `index.html`.
2. Copy your other files (scripts, styles, images) next to it. Keep links relative (`app.js`, not `/app.js`), because the site lives under `/BMTR-sketch-to-risa/`.
3. Leave these alone: `prototype/`, `team.html`, `team.json`, `.claude/`, `.nojekyll`, `README.md`, `CONTRIBUTING.md`, `HOSTING.md`.
4. Test locally with `python -m http.server 8080` and open http://localhost:8080.
5. Push and open a pull request:

```bash
git add -A
git commit -m "Team app: Afshin's version at the site root"
git push -u origin afshin-app
```

Once it's merged into `main`, the site updates within a minute or two.

## 3B. Built with a tool (React, Vite and similar)

Pages serves the build output, and a workflow builds it on every push to `main`.

1. Put your project at the repo root (`package.json` at the root). Delete the forwarding `index.html` at the root, since your build makes its own.
2. Set the base path so assets load under `/BMTR-sketch-to-risa/`. For Vite, in `vite.config.js`:

```js
export default defineConfig({ base: "/BMTR-sketch-to-risa/", /* ...your config */ });
```

3. Copy the prototype and team page into the build so they stay live. Put them in `public/`, which Vite copies as is:
   - Move `prototype/` to `public/prototype/`.
   - Move `team.html` and `team.json` to `public/`.
   - Move `.nojekyll` to `public/`.

4. Add `.github/workflows/pages.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist   # your build output folder
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

5. Push on a branch and open a pull request, as in 3A.
6. Tell Kei before merging. The Pages source has to switch from "Deploy from a branch" to "GitHub Actions" (Settings > Pages) at the same moment, and only the repo owner can change it.

## 3C. Needs a server

GitHub Pages can't run server code. Two options:

- **Keep it in this repo and host it elsewhere:** put the code in `afshin-app/`, deploy it to a free host that reads from GitHub (Streamlit Community Cloud, Hugging Face Spaces or Render), then make the root `index.html` forward to that address. Kei can make that one-line change.
- **Move the parts that can run in the browser** into a static front end (3A or 3B) and keep only what truly needs a server on the free host.

**Never commit API keys or passwords.** Use the host's secrets settings. This repo is public.

## Ground rules

- Public sources only. Name the paper or doc behind any engineering method.
- Nothing from anyone's employer: no internal code, templates, standards or project data.
- The tool assists an engineer and shows its work. Don't describe results as acceptable, approved or compliant.

## Reusing the prototype

If your app could use them, two pieces of the prototype stand alone, with no dependencies:

- `prototype/detect.js`: `LineDetect.detect(canvas, rect, {minFrac})` finds straight members in a drawing or a sketch photo.
- `prototype/export.js`: `RisaExport.table / tsv / csv / dxf` turns nodes and members into RISA-3D spreadsheet rows and DXF.
