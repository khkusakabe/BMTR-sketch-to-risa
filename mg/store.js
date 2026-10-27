// Saved projects for the Model Generator. Project details live in localStorage and the
// uploaded plan file in IndexedDB, both in this browser only. Nothing is uploaded anywhere.
"use strict";

window.MGStore = (() => {
  const KEY = "mg-projects";

  function list() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; }
  }
  function writeList(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* storage unavailable */ }
  }
  function save(p) { writeList([p, ...list().filter((x) => x.id !== p.id)]); }
  function get(id) { return list().find((x) => x.id === id) || null; }
  function update(id, fields) { const p = get(id); if (p) save({ ...p, ...fields }); }

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("model-generator", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function putFile(id, file) {
    try {
      const d = await db();
      await new Promise((resolve, reject) => {
        const t = d.transaction("files", "readwrite");
        t.objectStore("files").put(file, id);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
      return true;
    } catch (e) { return false; }
  }
  async function getFile(id) {
    try {
      const d = await db();
      return await new Promise((resolve, reject) => {
        const q = d.transaction("files").objectStore("files").get(id);
        q.onsuccess = () => resolve(q.result || null);
        q.onerror = () => reject(q.error);
      });
    } catch (e) { return null; }
  }

  // "frame" | "truss" | "bldg" | "misc" -> how the Projects table and workspace name it
  function systemLabel(p) {
    return {
      frame: "2D Frame",
      truss: "2D Truss",
      bldg: `3D Building · ${p.stories} ${p.stories === 1 ? "story" : "stories"}`,
      misc: "3D Misc Frame",
    }[p.kind] || p.kind;
  }

  return { list, save, get, update, putFile, getFile, systemLabel };
})();
