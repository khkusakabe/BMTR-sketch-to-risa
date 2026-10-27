// Makes the New Project mockup work: real upload (PDF pages become the sheet choices),
// then Create Project saves the project and opens its workspace.
"use strict";

(() => {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const $ = (id) => document.getElementById(id);
  const input = $("fileInput"), drop = $("drop"), card = $("fileCard"), sheets = $("sheets");
  let file = null, page = 1;

  card.hidden = true;  // the mockup's example file shows until a real one is chosen

  const pick = (e) => { e.preventDefault(); input.click(); };
  $("browse").addEventListener("click", pick);
  $("replace").addEventListener("click", pick);
  drop.addEventListener("click", (e) => { if (e.target === drop) input.click(); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "#1f5f9e"; });
  drop.addEventListener("dragleave", () => { drop.style.borderColor = "#8a8a8a"; });
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.style.borderColor = "#8a8a8a"; useFile(e.dataTransfer.files[0]); });
  input.addEventListener("change", () => useFile(input.files[0]));

  function sheetButton(label, canvas, n) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", n === page ? "true" : "false");
    b.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px;padding:0;border:0;background:none;font:inherit;color:#1b1b1b;cursor:pointer";
    const frame = document.createElement("span");
    frame.className = "tile";
    frame.style.cssText = "width:104px;height:72px;box-sizing:border-box;display:grid;place-items:center;border-radius:6px;overflow:hidden;background:#fff";
    canvas.style.cssText = "max-width:96px;max-height:64px";
    frame.appendChild(canvas);
    const text = document.createElement("span");
    text.className = "lbl";
    text.style.fontSize = "13px";
    text.textContent = label;
    b.append(frame, text);
    b.addEventListener("click", () => {
      page = n;
      sheets.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    });
    return b;
  }

  function thumb(source, w, h) {
    const c = document.createElement("canvas");
    const k = Math.min(192 / w, 128 / h);
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  async function useFile(f) {
    if (!f) return;
    file = f; page = 1;
    card.hidden = false;
    $("fileName").textContent = f.name;
    $("fileMeta").textContent = "Reading...";
    sheets.innerHTML = "";
    try {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
        $("fileMeta").textContent = `${pdf.numPages} ${pdf.numPages === 1 ? "page" : "pages"}`;
        for (let n = 1; n <= Math.min(pdf.numPages, 12); n++) {
          const pg = await pdf.getPage(n);
          const vp = pg.getViewport({ scale: 0.4 });
          const c = document.createElement("canvas");
          c.width = vp.width; c.height = vp.height;
          await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
          sheets.appendChild(sheetButton("Page " + n, thumb(c, c.width, c.height), n));
        }
      } else {
        const img = new Image();
        img.src = URL.createObjectURL(f);
        await img.decode();
        $("fileMeta").textContent = `Image · ${img.naturalWidth} x ${img.naturalHeight} px`;
        sheets.appendChild(sheetButton("Sheet 1", thumb(img, img.naturalWidth, img.naturalHeight), 1));
      }
    } catch (err) {
      $("fileMeta").textContent = "Could not read this file: " + err.message;
    }
  }

  const pressed = (attr) => {
    const b = document.querySelector(`[${attr}][aria-pressed="true"]`);
    return b ? b.getAttribute(attr) : null;
  };

  $("create").addEventListener("click", async (e) => {
    e.preventDefault();
    const dim = pressed("data-dim") || "2D";
    const kind = dim === "2D" ? (pressed("data-sub2") || "frame") : (pressed("data-sub3") || "bldg");
    const stories = parseInt($("stories").textContent, 10) || 1;
    const p = {
      id: Date.now().toString(36),
      name: $("pname").value.trim() || $("pname").placeholder,
      number: $("pnum").value.trim() || $("pnum").placeholder,
      date: $("pdate").value,
      dim, kind, stories,
      fileName: file ? file.name : "",
      page: file ? page : null,
      status: "Draft",
    };
    if (file) await MGStore.putFile(p.id, file);
    MGStore.save(p);
    location.href = "generate.html?id=" + encodeURIComponent(p.id);
  });
})();
