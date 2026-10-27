// Projects home: saved projects appear above the example rows, and search filters the table.
"use strict";

(() => {
  const body = document.getElementById("projectRows");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cell = "padding: 14px 12px; border-bottom: 1px solid #d6d6d6;";
  const fmtDate = (d) => {
    const t = d ? new Date(d + "T12:00:00") : null;
    return t && !isNaN(t) ? t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  };

  const rows = MGStore.list().map((p) => `
    <tr>
      <td style="padding: 14px 12px 14px 0; border-bottom: 1px solid #d6d6d6;"><a href="generate.html?id=${encodeURIComponent(p.id)}" style="display: flex; flex-direction: column; gap: 2px; text-decoration: none"><span style="font-weight: 600">${esc(p.name)}</span><span style="font-size: 13px; color: #6b6b6b">${esc(p.number)}</span></a></td>
      <td style="${cell}">${esc(MGStore.systemLabel(p))}</td>
      <td style="${cell} color: #4a4a4a">${p.fileName ? esc(p.fileName) + (p.page ? " · p." + p.page : "") : "No plan"}</td>
      <td style="${cell}"><span style="font-size: 14px">${p.kind === "frame" || p.kind === "bldg" ? "ASCE 7-22 ASD" : "Not set"}</span></td>
      <td style="${cell}"><span style="display: inline-flex; align-items: center; gap: 8px"><span style="width: 8px; height: 8px; border-radius: 50%; background: ${p.status === "Exported" ? "#1b1b1b" : "#1f5f9e"}"></span>${esc(p.status)}</span></td>
      <td style="padding: 14px 0 14px 12px; border-bottom: 1px solid #d6d6d6; text-align: right; color: #6b6b6b; font-size: 14px">${esc(fmtDate(p.date))}</td>
    </tr>`).join("");
  body.insertAdjacentHTML("afterbegin", rows);

  const search = document.querySelector('input[placeholder="Search projects"]');
  if (search) {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      body.querySelectorAll("tr").forEach((tr) => { tr.hidden = q && !tr.textContent.toLowerCase().includes(q); });
    });
  }
})();
