# Sketch to RISA: the team app

By Afshin, team BMTR, NCSEA Big Build SE Hackathon, 2026-10-27.

A local control panel that turns a framing sketch photo or an architectural PDF plan into a RISA-3D model, then opens it in RISA.

- **Sketch photo:** cleans up the line work (OpenCV, scikit-image, skan), reads the dimensions and sizes (EasyOCR), then a Claude agent drafts the framing, checks its own drawing against the photo and revises until they match.
- **PDF plan:** renders the page to scale (PyMuPDF), and a Claude agent lays out steel floor framing on it. You review the overlay and ask for changes.
- **Editor:** adjust the framing in the browser before export.
- **RISA-3D:** writes a native `.r3d` model (feet and kips, plan in the X-Z plane at story height) from a RISA-3D 23 template, and launches RISA-3D with it.

## Why it runs on your PC, not on GitHub Pages

It's a Python server (`server.py`) that runs on your own computer at http://127.0.0.1:8765. It needs Python packages, a Claude login or API key, and RISA-3D installed to open models. GitHub Pages only serves static files, so the online site links here instead. The browser-only prototype at `/prototype/` is the try-it-online demo.

## Run it

Needs Windows, Python 3.10 or newer, and RISA-3D installed in `C:\Program Files\RISA` to open models.

```bash
git clone https://github.com/khkusakabe/BMTR-sketch-to-risa.git
cd BMTR-sketch-to-risa/app
python -m pip install -r requirements.txt
python server.py
```

Or double-click `start.bat`. The panel opens in your browser.

The first EasyOCR run downloads its text-reading models, which can take a few minutes.

## Claude engine: pick one

- **Claude Code ("cc"):** uses your own Claude login, no key needed. The app finds `claude` on your PATH, the Claude Code VS Code extension, or `CLAUDE_CODE_EXE`.
- **Claude API ("api"):** set `ANTHROPIC_API_KEY`, or paste a key into the panel. It's saved in `%APPDATA%\RISA-Control-Panel\config.json` on your PC, never in this repo.

**Never commit a key.** This repo is public.

## Files

| File | What it does |
|---|---|
| `server.py` | Local web server and JSON API: finds and launches RISA-3D, runs jobs |
| `index.html`, `editor.js` | The control panel and framing editor |
| `sketch.py` | Photo to clean line work: strokes, skeleton, straight segments, grid snapping |
| `sketch_agent.py` | OCR, then the Claude agent loop for sketches |
| `plan_agent.py` | The Claude agent loop for PDF plans |
| `cc_agent.py`, `cc_check.py` | The same loops run through Claude Code, plus the checker it runs after each draft |
| `risa_r3d.py` | Writes the `.r3d` model from the saved framing |
| `templates/w_shapes.json` | W-shape names the agent may pick from |
| `samples/` | A sketch photo and a cleaned-up sketch to try |

## Note

This tool helps an engineer build a starting model faster. The engineer checks every member, size, connection and support in RISA and owns the design.
