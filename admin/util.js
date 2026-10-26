// Small helpers for the admin dashboard: formatting, dates, CSV, WhatsApp links, dialogs.

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pad = n => String(n).padStart(2, "0");
export const sum = (rows, fn) => rows.reduce((t, r) => t + (Number(fn(r)) || 0), 0);

// ---------- Dates (local time; strings are YYYY-MM-DD and YYYY-MM) ----------
export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const thisMonth = () => todayISO().slice(0, 7);
export const nowISO = () => new Date().toISOString();
export function nowTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const monthIndex = ym => { const [y, m] = ym.split("-").map(Number); return y * 12 + m - 1; };
export function addMonths(ym, n) {
  const t = monthIndex(ym) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export const monthDiff = (a, b) => monthIndex(b) - monthIndex(a);
export function overlapMonths(aStart, aLen, bStart, bLen) {
  const a = monthIndex(aStart), b = monthIndex(bStart);
  return Math.max(0, Math.min(a + aLen, b + bLen) - Math.max(a, b));
}
export function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
export function addDays(iso, n) {
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  d.setDate(d.getDate() + n);
  return todayISO(d);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtMonth(ym) {
  if (!ym) return "—";
  const [y, m] = ym.split("-");
  return `${MONTHS[+m - 1]} ${y}`;
}
export function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${+d} ${MONTHS[+m - 1]} ${y}`;
}
export function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export const periodLabel = (ym, months) => (Number(months) > 1 ? `${fmtMonth(ym)} – ${fmtMonth(addMonths(ym, Number(months) - 1))}` : fmtMonth(ym));
export function ageFrom(dob) {
  if (!dob) return "";
  const b = new Date(dob + "T00:00:00"), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a >= 0 && a < 120 ? a : "";
}
// Accepts 2026-10-26, 26/10/2026, 26-10-26 and Excel serial numbers.
export function parseDate(s) {
  s = String(s ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) { const [y, m, d] = s.slice(0, 10).split("-"); return `${y}-${pad(+m)}-${pad(+d)}`; }
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${pad(+m[2])}-${pad(+m[1])}`; }
  if (/^\d{5}$/.test(s)) return todayISO(new Date(Date.UTC(1899, 11, 30) + Number(s) * 864e5));
  const d = new Date(s);
  return isNaN(d) ? "" : todayISO(d);
}

// ---------- Money ----------
export function money(n, cur = "AED") {
  const v = Number(n) || 0;
  return `${cur} ${v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

// ---------- WhatsApp ----------
export function waNumber(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("05")) d = "971" + d.slice(1);
  else if (d.length === 9 && d.startsWith("5")) d = "971" + d;
  return d.length >= 8 ? d : "";
}
export function waLink(phone, text) {
  const n = waNumber(phone);
  return n ? `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ""}` : "";
}

// ---------- CSV (Excel opens these directly) ----------
export function toCSV(rows, cols) {
  const q = v => {
    const s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map(c => q(c[0])).join(",");
  const body = rows.map(r => cols.map(c => q(typeof c[1] === "function" ? c[1](r) : r[c[1]])).join(","));
  return "﻿" + [head, ...body].join("\r\n");
}
export function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "";
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : first.includes("\t") && !first.includes(",") ? "\t" : ",";
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}
export function download(name, content, type = "text/csv;charset=utf-8") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- UI: options, forms, toasts, modals ----------
export function options(list, selected, { blank } = {}) {
  const sel = Array.isArray(selected) ? selected : [selected];
  return (blank !== undefined ? `<option value="">${esc(blank)}</option>` : "") +
    list.map(o => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}"${sel.includes(v) || sel.includes(String(v)) ? " selected" : ""}>${esc(l)}</option>`;
    }).join("");
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") {
      if ("multi" in el.dataset) { (out[el.name] ||= []); if (el.checked) out[el.name].push(el.value); }
      else out[el.name] = el.checked;
    } else if (el.type === "radio") { if (el.checked) out[el.name] = el.value; }
    else if (el.type === "number") out[el.name] = el.value === "" ? "" : Number(el.value);
    else if (el.type === "file") continue;
    else out[el.name] = el.value.trim();
  }
  return out;
}

export function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3200);
}

const live = new Set();
export function refreshLive() {
  for (const m of live) {
    if (!m.el.isConnected) { live.delete(m); continue; }
    const html = m.render();
    if (html === null) { m.close(); continue; }
    m.form.innerHTML = html;
  }
}

// opts: { title, body, footer, submitLabel, onSubmit(data, form), wide, live: () => html|null, onOpen(el) }
export function modal(opts) {
  const root = document.getElementById("modal-root");
  const el = document.createElement("div");
  el.className = "modal-backdrop";
  const footer = opts.footer ?? `<footer><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${esc(opts.submitLabel || "Save")}</button></footer>`;
  el.innerHTML = `<div class="modal${opts.wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
    <header><h2>${esc(opts.title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <form class="modal-body" novalidate>${opts.live ? opts.live() : opts.body + footer}</form></div>`;
  root.appendChild(el);
  const form = el.querySelector("form");
  const prevFocus = document.activeElement;
  const close = () => { el.remove(); live.delete(handle); if (prevFocus && prevFocus.isConnected) prevFocus.focus(); };
  const handle = { el, form, close, render: opts.live };
  if (opts.live) live.add(handle);
  el.addEventListener("mousedown", e => { if (e.target === el) close(); });
  el.addEventListener("click", e => { if (e.target.closest("[data-close]")) close(); });
  el.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (!opts.onSubmit) return;
    for (const f of form.querySelectorAll("[required]")) {
      if (!String(f.value).trim()) { f.focus(); toast(`Please fill in "${f.closest("div")?.querySelector("label")?.textContent?.replace("*", "").trim() || f.name}".`, "error"); return; }
    }
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const btn = form.querySelector("[type=submit]");
    if (btn) btn.disabled = true;
    try {
      const r = await opts.onSubmit(formData(form), form);
      if (r !== false) close();
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), "error");
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  });
  if (opts.onOpen) opts.onOpen(el, handle);
  setTimeout(() => (form.querySelector("[autofocus]") || form.querySelector("input:not([type=hidden]):not([type=checkbox]),select,textarea"))?.focus(), 30);
  return handle;
}

export function confirmBox(text, { okLabel = "Confirm", danger = false, title = "Please confirm" } = {}) {
  return new Promise(resolve => {
    let done = false;
    const h = modal({
      title,
      body: `<p style="margin:0">${text}</p>`,
      footer: `<footer><button type="button" class="btn" data-close>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" type="submit">${esc(okLabel)}</button></footer>`,
      onSubmit: () => { done = true; resolve(true); }
    });
    const obs = new MutationObserver(() => { if (!h.el.isConnected) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.getElementById("modal-root"), { childList: true });
  });
}
