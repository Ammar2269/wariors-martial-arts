// Wariors admin dashboard: members, memberships & renewals, payments, receipt photos, expenses & bills, class schedule,
// equipment & stock, trial requests, attendance, reports and an automatic activity log.
// Data lives in Firestore (or localStorage in demo mode).
import { store, MODE, COLLECTIONS, PHOTOS } from "./store.js";
import * as U from "./util.js";

const { esc, sum, fmtDate, fmtMonth, options } = U;
const modal = U.modal;
const num = v => Number(v) || 0;
const round = n => Math.round(n * 100) / 100;

// ---------- Fixed lists ----------
const PROGRAMS = ["MMA", "Kickboxing", "Muay Thai", "Boxing", "Karate", "Kalaripayattu", "BJJ", "Yoga", "Zumba", "SheFit", "Aerobics", "Gymnastics Floor", "CrossFit", "Fitness", "EMS", "Personal Training"];
const PAY_TYPES = ["Membership", "Uniform & gear sale", "Registration fee", "Personal training", "Grading / belt test", "Event / competition", "Other income"];
const CHARGE_TYPES = ["Uniform & gear sale", "Registration fee", "Personal training", "Grading / belt test", "Event / competition", "Other income"];
const METHODS = ["Cash", "Card", "Bank transfer", "Payment link", "Cheque", "Other"];
const EXP_METHODS = ["Cash", "Petty cash", "Card", "Bank transfer", "Cheque", "Other"];
const EXP_CATS = ["Rent", "Utilities (electricity & water)", "Internet & phone", "Salaries & coach fees", "Equipment purchase", "Equipment repair & service", "Maintenance", "Transport & fuel", "Office supplies & refreshments", "Cleaning & supplies", "Marketing & ads", "Events & competitions", "Licences & insurance", "Refunds", "Other"];
const EQ_CATS = ["Kit for sale (stock)", "Mats & flooring", "Gloves & wraps", "Pads & shields", "Bags", "Protective gear", "Weights & strength", "Cardio machines", "EMS equipment", "Yoga & mobility", "Other"];
const EQ_COND = ["New", "Good", "Worn", "Needs repair", "Retired"];
const LEAD_STATUS = ["New", "Call back", "Contacted", "Trial booked", "Attended trial", "Joined", "Not interested", "Old enquiry"];
const LEAD_OPEN = ["New", "Call back", "Contacted", "Trial booked", "Attended trial"];
const LEAD_SOURCES = ["Walk-in", "Phone call", "WhatsApp", "Instagram", "TikTok", "Website", "Referral", "Other"];
const AGE_GROUPS = ["Adult (18+)", "Teen (13–17)", "Child (under 13)", "Family / more than one person"];
const TIMES = ["Evening", "Morning", "Weekend", "Any time"];
const CANCEL_REASONS = ["Moved away", "Too expensive", "Schedule doesn't fit", "Injury / health", "Lost interest", "Joined another club", "Goal reached / finished", "Other"];
const DAYS = [["Mon", "Monday"], ["Tue", "Tuesday"], ["Wed", "Wednesday"], ["Thu", "Thursday"], ["Fri", "Friday"], ["Sat", "Saturday"], ["Sun", "Sunday"]];
const GROUPS = ["Adults – mix", "Ladies", "Kids", "Men", "All"];

const DEFAULT_SETTINGS = {
  clubName: "Wariors Martial Arts Club",
  whatsapp: "971562613563",
  currency: "AED",
  renewWindow: 7,
  reminderText: "Hi {name}, this is {club}. Your membership ended on {date}. We'd love to see you back on the mat! The renewal is {amount}. Thank you!",
  balanceText: "Hi {name}, this is {club}. A friendly reminder that {amount} is still due for {what}. Thank you!",
  cancelText: "Hi {name}, this is {club}. Your membership ended on {date} and we have it as cancelled. Could you let us know if you want to cancel for sure, or would you like to renew? Just reply CANCEL or RENEW. We'd love to have you back on the mat!",
  accountantName: "Accountant group",
  accountantLink: "",
  plans: [],
  extraFees: [],
  schedule: [],
  bills: []
};

// ---------- State ----------
const todayDay = () => DAYS[(new Date().getDay() + 6) % 7][0];
const S = {
  user: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  loaded: new Set(),
  members: [], memberships: [], payments: [], expenses: [], equipment: [], leads: [], handouts: [], attendance: [], activity: [], receipts: [], dailyReports: [],
  route: "dashboard",
  loginMsg: "",
  ui: {
    mq: "", mfilter: "current", mprog: "",
    payTab: "renewals", payMonth: U.thisMonth(), payQ: "",
    rcFilter: "unsent", rcSel: [], rcType: "", rcKind: "in",
    expMonth: U.thisMonth(), expCat: "",
    eqQ: "", eqCond: "",
    leadFilter: "open",
    attDate: U.todayISO(),
    schedDay: todayDay(),
    repYear: U.todayISO().slice(0, 4), repMonth: U.thisMonth(), cashMethod: "",
    actQ: "",
    draft: null
  }
};

const money = n => U.money(n, S.settings.currency || "AED");
// Everyone shares one login, so each device remembers the name of the person using it for the activity log.
const PERSON_KEY = "wma-person";
const person = () => { try { return localStorage.getItem(PERSON_KEY) || ""; } catch { return ""; } };
const who = () => person() || S.user?.email || "admin";
const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
const memberById = id => S.members.find(m => m.id === id);
const membershipById = id => S.memberships.find(m => m.id === id);
const badge = (cls, text) => `<span class="badge ${cls}">${esc(text)}</span>`;
const empty = text => `<div class="empty">${text}</div>`;
const firstName = s => String(s || "").split(/[\s(+&,-]/).filter(Boolean)[0] || "";

async function log(text) {
  try { await store.add("activity", { at: U.nowISO(), by: who(), text }); } catch (e) { console.warn("activity log failed", e); }
}

// ---------- Memberships, balances and renewals ----------
// A membership runs from startDate to endDate and costs packageAmount + kitAmount.
// A charge (kind "charge") is a one-off amount owed, e.g. gloves or a registration fee.
// What's paid = paidBeforeImport (from Excel) + payments linked to it by membershipId.
let idx = null; // rebuilt whenever members, memberships or payments change
const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
function I() {
  if (idx) return idx;
  idx = { paysByMs: new Map(), paysByMember: new Map(), msByMember: new Map() };
  for (const p of S.payments) {
    if (p.membershipId) push(idx.paysByMs, p.membershipId, p);
    if (p.memberId) push(idx.paysByMember, p.memberId, p);
  }
  for (const ms of S.memberships) if (ms.memberId) push(idx.msByMember, ms.memberId, ms);
  for (const list of idx.msByMember.values()) list.sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  for (const list of idx.paysByMember.values()) list.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return idx;
}
const totalOf = ms => ms.kind === "charge" ? num(ms.amount) : num(ms.packageAmount) + num(ms.kitAmount);
const paidOf = ms => round(num(ms.paidBeforeImport) + sum(I().paysByMs.get(ms.id) || [], p => p.amount));
const balanceOf = ms => Math.max(0, round(totalOf(ms) - paidOf(ms)));
const membershipsOf = mid => I().msByMember.get(mid) || [];
const paymentsOf = mid => I().paysByMember.get(mid) || [];
const latestOf = mid => membershipsOf(mid).find(x => x.kind !== "charge");
const windowDays = () => num(S.settings.renewWindow) || 7;
const whatOf = ms => ms.kind === "charge" ? (ms.description || "Charge") : `${ms.plan || "Membership"} (${fmtDate(ms.startDate)} – ${fmtDate(ms.endDate)})`;

function stateOf(m) {
  const ms = latestOf(m.id);
  const today = U.todayISO();
  if (m.status === "cancelled") return { state: "cancelled", ms };
  if (m.status === "paused") return { state: "paused", ms };
  if (!ms) return { state: "none" };
  if (ms.startDate && ms.startDate > today) return { state: "upcoming", ms, days: U.diffDays(today, ms.startDate) };
  if (!ms.endDate) return { state: "active", ms };
  const left = U.diffDays(today, ms.endDate);
  if (left < 0) return { state: "expired", ms, days: -left };
  if (left <= windowDays()) return { state: "ending", ms, days: left };
  return { state: "active", ms, days: left };
}
function stateBadge(st) {
  switch (st.state) {
    case "active": return badge("b-ok", "Active");
    case "ending": return badge("b-warn", st.days === 0 ? "Ends today" : `Ends in ${st.days} day${st.days === 1 ? "" : "s"}`);
    case "expired": return badge("b-bad", `Expired ${st.days} day${st.days === 1 ? "" : "s"} ago`);
    case "upcoming": return badge("b-info", `Starts ${fmtDate(st.ms.startDate)}`);
    case "paused": return badge("b-warn", "Paused");
    case "cancelled": return badge("b-mute", "Cancelled");
    default: return badge("b-mute", "No membership");
  }
}
const isCurrent = st => ["active", "ending", "upcoming"].includes(st.state);
function owedOf(m) {
  const list = membershipsOf(m.id).map(ms => ({ ms, bal: balanceOf(ms) })).filter(x => x.bal > 0);
  return { total: round(sum(list, x => x.bal)), list };
}
function renewalsDue() {
  return S.members.filter(m => !["cancelled", "paused"].includes(m.status || "active"))
    .map(m => ({ m, st: stateOf(m) }))
    .filter(r => r.st.state === "ending" || (r.st.state === "expired" && r.st.days <= 30))
    .sort((a, b) => (a.st.ms.endDate || "").localeCompare(b.st.ms.endDate || ""));
}
function owingList() {
  return S.members.filter(m => m.status !== "cancelled")
    .map(m => ({ m, o: owedOf(m) })).filter(r => r.o.total > 0)
    .sort((a, b) => b.o.total - a.o.total);
}
const fill = (tpl, vals) => Object.entries(vals).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), tpl);
const greetName = m => firstName(m.guardianPhone && !m.phone && m.guardianName ? m.guardianName : m.name);
function remindLink(m, kind, label = "Remind") {
  let text = "";
  if (kind === "renewal") {
    const ms = latestOf(m.id);
    text = fill(S.settings.reminderText || DEFAULT_SETTINGS.reminderText, { name: greetName(m), club: S.settings.clubName, date: fmtDate(ms?.endDate), amount: money(ms?.packageAmount) });
  } else if (kind === "cancel") {
    const ms = latestOf(m.id);
    text = fill(S.settings.cancelText || DEFAULT_SETTINGS.cancelText, { name: greetName(m), club: S.settings.clubName, date: fmtDate(ms?.endDate || m.cancelDate), amount: money(ms?.packageAmount) });
  } else {
    const o = owedOf(m);
    text = fill(S.settings.balanceText || DEFAULT_SETTINGS.balanceText, { name: greetName(m), club: S.settings.clubName, amount: money(o.total), what: o.list.map(x => x.ms.kind === "charge" ? x.ms.description : x.ms.plan || "your membership").join(", ") });
  }
  const url = U.waLink(m.phone || m.guardianPhone, text);
  return url ? `<a class="btn small wa" href="${esc(url)}" target="_blank" rel="noopener" data-act="remind" data-id="${esc(m.id)}" data-kind="${kind}">${label}</a>` : "";
}

// Cancelled members: has someone asked them yet whether they really want to cancel, and what did they say?
const ANSWERS = { renew: "Wants to renew", cancel: "Confirmed cancel", none: "No reply" };
function askState(m) {
  if (m.cancelAnswer) return badge(m.cancelAnswer === ANSWERS.renew ? "b-ok" : m.cancelAnswer === ANSWERS.cancel ? "b-mute" : "b-warn", m.cancelAnswer);
  if (m.cancelAskedAt) return badge("b-info", `Asked ${fmtDate(m.cancelAskedAt)}`);
  return badge("b-warn", "Not asked yet");
}
const notAskedYet = () => S.members.filter(m => m.status === "cancelled" && !m.cancelAskedAt && !m.cancelAnswer);

// ---------- Bills (recurring expenses from Settings) ----------
function billRows(ym) {
  return (S.settings.bills || [])
    .filter(b => !b.startMonth || b.startMonth <= ym)
    .map(b => {
      const entry = S.expenses.find(x => x.billId === b.id && x.period === ym);
      const due = `${ym}-${U.pad(Math.min(num(b.dueDay) || 1, U.daysInMonth(ym)))}`;
      const state = entry ? (entry.status === "unpaid" ? "unpaid" : "paid") : "missing";
      return { b, entry, due, state, overdue: state !== "paid" && U.todayISO() > due };
    });
}

// ---------- Boot & auth ----------
const $ = id => document.getElementById(id);

async function boot() {
  try {
    await store.init({ auth: true, cache: true });
  } catch (e) {
    $("boot").textContent = "Couldn't connect to the database. Check the internet connection, then reload.";
    console.error(e);
    return;
  }
  store.onAuth(async user => {
    if (!user) return showLogin();
    if (!(await store.isAdmin(user))) {
      S.loginMsg = "This login isn't allowed into the club admin. Ask the club manager.";
      await store.signOut();
      return;
    }
    S.user = user;
    startApp();
  });
}

function showLogin() {
  stopData();
  S.user = null;
  $("boot").hidden = true;
  $("app").hidden = true;
  $("login").hidden = false;
  const msg = S.loginMsg;
  S.loginMsg = "";
  if (MODE === "demo") {
    $("login-body").innerHTML = `
      <div class="callout warn">Demo mode: no database is connected yet, so everything here is made-up sample data saved only in this browser.</div>
      <div style="display:grid;gap:8px;margin-top:14px">
        <button class="btn primary" id="demo-sample" type="button">Open with sample data</button>
        <button class="btn" id="demo-empty" type="button">Open (keep my demo data)</button>
      </div>`;
    $("demo-sample").onclick = async () => { await seedDemo(); await store.signIn(); };
    $("demo-empty").onclick = () => store.signIn();
    return;
  }
  $("login-body").innerHTML = `
    <form id="login-form" novalidate>
      <div class="field"><label for="l-user">Username</label><input id="l-user" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></div>
      <div class="field"><label for="l-pass">Password</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
      <button class="btn primary" type="submit">Sign in</button>
      <p class="login-err" id="login-err">${esc(msg)}</p>
      <p class="hint">Forgot the password? Ask the club manager.</p>
    </form>`;
  $("login-form").onsubmit = async e => {
    e.preventDefault();
    const user = $("l-user").value.trim(), pass = $("l-pass").value;
    if (!user || !pass) { $("login-err").textContent = "Enter the username and password."; return; }
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try { await store.signIn(user, pass); }
    catch (err) { $("login-err").textContent = /invalid|wrong|not-found|credential|user-disabled/i.test(err.code || err.message) ? "Wrong username or password." : /too-many/i.test(err.code || "") ? "Too many tries. Wait a few minutes and try again." : (err.message || "Sign-in failed."); }
    finally { btn.disabled = false; }
  };
}

// Asks who is using this device (shared login), so the activity log shows real names.
function askPerson(force = false) {
  if (person() && !force) return;
  const names = [...new Set(S.activity.map(a => a.by).filter(n => n && !n.includes("@") && n !== "Excel import"))].slice(0, 12);
  modal({
    title: "Who's using this?",
    body: `<p class="hint" style="margin-top:0">Everyone shares one login, so your name is saved on this device and shown in the activity log next to what you change.</p>
      <label for="pp-name">Your name</label><input id="pp-name" name="name" required maxlength="40" value="${esc(person())}" list="pp-names" autocomplete="name" autofocus>
      <datalist id="pp-names">${names.map(n => `<option value="${esc(n)}">`).join("")}</datalist>`,
    footer: `<footer><button class="btn primary" type="submit">Continue</button></footer>`,
    onSubmit(d) {
      try { localStorage.setItem(PERSON_KEY, d.name); } catch {}
      showWho();
      U.toast(`Hi ${d.name}!`);
    }
  });
}
function showWho() {
  $("who").innerHTML = `${esc(person() || S.user.name || S.user.email)}<small>${MODE === "demo" ? "Demo mode" : "Signed in to the club account"}</small>`;
}

let unsubs = [];
function stopData() { unsubs.forEach(u => u && u()); unsubs = []; }

function startApp() {
  $("boot").hidden = true;
  $("login").hidden = true;
  $("app").hidden = false;
  showWho();
  $("banner").innerHTML = MODE === "demo" ? `<div class="banner"><b>Demo mode.</b> Made-up sample data, saved only in this browser.</div>` : "";
  stopData();
  const onErr = e => U.toast("Couldn't load data: " + (e.message || e), "error");
  S.loaded = new Set();
  const sub = (col, opts) => unsubs.push(store.subscribe(col, rows => {
    S[col] = rows;
    if (col === "payments" || col === "memberships") idx = null;
    S.loaded.add(col);
    scheduleRender();
  }, opts, onErr));
  ["members", "memberships", "payments", "expenses", "equipment", "leads", "handouts"].forEach(c => sub(c));
  sub("receipts", { orderBy: ["createdAt", "desc"], limit: 400 });
  sub("dailyReports", { orderBy: ["date", "desc"], limit: 120 });
  sub("attendance", { since: { field: "date", value: U.addDays(U.todayISO(), -120) } });
  sub("activity", { orderBy: ["at", "desc"], limit: 300 });
  unsubs.push(store.subscribeDoc("settings", "main", d => {
    const { id, ...rest } = d || {};
    S.settings = { ...DEFAULT_SETTINGS, ...rest };
    S.loaded.add("settings");
    scheduleRender();
  }, onErr));
  route();
  askPerson();
}

// ---------- Rendering ----------
const ICONS = {
  dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  members: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  payments: "M2 5h20v14H2zM2 10h20M6 15h4",
  receipts: "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  expenses: "M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2zM9 7h6M9 11h6M9 15h3",
  schedule: "M3 4h18v18H3zM16 2v4M8 2v4M3 10h18M8 14h3M8 18h3M14 14h3",
  equipment: "M6.5 6.5h11M6.5 17.5h11M3 9v6M21 9v6M6.5 4v16M17.5 4v16",
  leads: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z",
  attendance: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  reports: "M18 20V10M12 20V4M6 20v-6",
  activity: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  settings: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  more: "M4 6h16M4 12h16M4 18h16"
};
const ROUTES = [
  ["dashboard", "Dashboard"], ["members", "Members"], ["payments", "Payments & renewals"], ["receipts", "Receipts & vouchers"], ["expenses", "Expenses & bills"],
  ["schedule", "Class schedule"], ["equipment", "Equipment & stock"], ["leads", "Trial requests"], ["attendance", "Attendance"],
  ["reports", "Reports & cash book"], ["activity", "Activity log"], ["settings", "Settings"]
];
const BOTTOM = [["dashboard", "Home"], ["members", "Members"], ["payments", "Payments"], ["schedule", "Schedule"]];

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { render(); U.refreshLive(); }, 20);
}

function navCounts() {
  const ym = U.thisMonth();
  return {
    payments: renewalsDue().length,
    receipts: S.receipts.filter(r => !r.sentAt).length,
    leads: S.leads.filter(l => l.status === "New").length,
    expenses: billRows(ym).filter(b => b.overdue).length + S.expenses.filter(x => x.status === "unpaid" && x.dueDate && x.dueDate < U.todayISO()).length
  };
}
const icon = id => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[id]}"/></svg>`;

function renderNav() {
  const c = navCounts();
  $("side-nav").innerHTML = ROUTES.map(([id, label]) =>
    `<a href="#${id}" class="${S.route === id ? "active" : ""}">${icon(id)}${label}${c[id] ? `<span class="count" title="Needs attention">${c[id]}</span>` : ""}</a>`
  ).join("");
  const inBottom = BOTTOM.some(b => b[0] === S.route);
  $("bottom-nav").innerHTML = BOTTOM.map(([id, label]) =>
    `<a href="#${id}" class="${S.route === id ? "active" : ""}">${icon(id)}<span>${label}</span>${c[id] ? `<i class="dot">${c[id]}</i>` : ""}</a>`
  ).join("") + `<button type="button" class="${inBottom ? "" : "active"}" data-act="more">${icon("more")}<span>More</span>${c.leads + c.expenses + c.receipts ? `<i class="dot">${c.leads + c.expenses + c.receipts}</i>` : ""}</button>`;
}

// On phones, tables are shown as cards; each cell needs its column name as a label.
function labelTables(root) {
  for (const t of root.querySelectorAll("table.t")) {
    const heads = [...t.querySelectorAll("thead th")].map(th => th.textContent.trim());
    for (const tr of t.querySelectorAll("tbody tr, tfoot tr")) {
      let i = 0;
      for (const td of tr.children) {
        if (!td.hasAttribute("data-label")) td.setAttribute("data-label", heads[i] || "");
        i += Number(td.getAttribute("colspan")) || 1;
      }
    }
  }
}

function render() {
  if (!S.user) return;
  renderNav();
  const r = ROUTES.find(x => x[0] === S.route) || ROUTES[0];
  $("page-title").textContent = r[1];
  document.title = `${r[1]} · Wariors Admin`;
  const view = $("view");
  const act = document.activeElement;
  const focusId = act && view.contains(act) && act.id ? act.id : null;
  const caret = focusId && "selectionStart" in act ? act.selectionStart : null;
  if (!["members", "memberships", "payments", "expenses", "settings"].every(c => S.loaded.has(c))) {
    view.innerHTML = empty("Loading club data…");
    return;
  }
  try {
    view.innerHTML = VIEWS[r[0]]();
    labelTables(view);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="callout bad">Something went wrong showing this page: ${esc(err.message)}. Try reloading.</div>`;
    return;
  }
  if (focusId) {
    const el = $(focusId);
    if (el) { el.focus(); if (caret != null) try { el.setSelectionRange(caret, caret); } catch {} }
  }
}

function route() {
  const id = (location.hash || "#dashboard").slice(1).split("?")[0];
  const next = ROUTES.some(r => r[0] === id) ? id : "dashboard";
  if (next !== "settings") S.ui.draft = null;
  S.route = next;
  $("side").classList.remove("open");
  render();
  window.scrollTo(0, 0);
}

// ---------- Small view helpers ----------
const kpi = (label, value, sub = "", cls = "", href = "") => `<${href ? `a href="${href}"` : "div"} class="kpi ${cls}"${href ? ' style="text-decoration:none;color:inherit"' : ""}><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</${href ? "a" : "div"}>`;
const incomeIn = ym => sum(S.payments.filter(p => (p.date || "").startsWith(ym)), p => p.amount);
const spentIn = ym => sum(S.expenses.filter(x => x.status !== "unpaid" && (x.date || "").startsWith(ym)), x => x.amount);
const seg = (key, v, label) => `<button class="${S.ui[key] === v ? "on" : ""}" data-act="ui" data-id="${key}=${v}">${label}</button>`;
const memberCell = m => `<b>${esc(m.name)}</b><span class="sub">${esc(m.phone || m.guardianPhone || "")}${m.guardianName ? ` · ${esc(m.guardianName)}` : ""}</span>`;

function barChart(data) {
  const W = 640, H = 220, padL = 46, padB = 26, padT = 10;
  const max = Math.max(1000, ...data.flatMap(d => [d.a, d.b]));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const gw = (W - padL - 10) / data.length;
  const bw = Math.min(26, gw / 3);
  const y = v => padT + (H - padT - padB) * (1 - v / top);
  let svg = "";
  for (let i = 0; i <= 4; i++) {
    const v = top * i / 4;
    svg += `<line x1="${padL}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : v}</text>`;
  }
  data.forEach((d, i) => {
    const x = padL + gw * i + gw / 2;
    svg += `<rect x="${x - bw - 2}" y="${y(d.a)}" width="${bw}" height="${Math.max(0, y(0) - y(d.a))}" rx="3" fill="var(--brand)"><title>${esc(d.label)} income: ${esc(money(d.a))}</title></rect>`;
    svg += `<rect x="${x + 2}" y="${y(d.b)}" width="${bw}" height="${Math.max(0, y(0) - y(d.b))}" rx="3" fill="var(--muted)" opacity=".55"><title>${esc(d.label)} expenses: ${esc(money(d.b))}</title></rect>`;
    svg += `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(d.label)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and expenses for the last 6 months">${svg}</svg>`;
}

// ---------- Views ----------
function viewDashboard() {
  const ym = U.thisMonth();
  if (!S.members.length) {
    return `<div class="panel"><div class="panel-body" style="padding:24px">
      <h2 style="font-size:18px;margin-bottom:8px">Welcome! Let's set up the club.</h2>
      <ol style="margin:0 0 16px;padding-left:20px;line-height:1.9">
        <li>Check the fee plans, monthly bills and class schedule in <a href="#settings">Settings</a>.</li>
        <li>Add members, or import a list from Excel in <a href="#settings">Settings → Import</a>.</li>
        <li>Start a membership for each member. Renewals and unpaid balances then show up here automatically.</li>
      </ol>
      <button class="btn primary" data-act="new-member">+ Add first member</button></div></div>`;
  }
  const due = renewalsDue();
  const owing = owingList();
  const collected = incomeIn(ym), spent = spentIn(ym);
  const states = S.members.map(m => stateOf(m));
  const current = states.filter(isCurrent).length;
  const newLeads = S.leads.filter(l => l.status === "New").length;
  const bills = billRows(ym).filter(b => b.state !== "paid");
  const unpaidInv = S.expenses.filter(x => x.status === "unpaid" && !x.billId);
  const hand = S.handouts.filter(h => !h.done);
  const soon = U.addDays(U.todayISO(), 14);
  const eq = S.equipment.filter(e => e.condition === "Needs repair" || (e.serviceDue && e.serviceDue <= soon && e.condition !== "Retired"));
  const outOfStock = S.equipment.filter(e => e.forSale && num(e.qty) <= 0);
  const pauseEnded = S.members.filter(m => m.status === "paused" && m.pauseUntil && m.pauseUntil < U.todayISO());
  const toAsk = notAskedYet().length;
  const unsent = S.receipts.filter(r => !r.sentAt).length;
  const chart = Array.from({ length: 6 }, (_, i) => { const m = U.addMonths(ym, i - 5); return { label: fmtMonth(m).slice(0, 3), a: incomeIn(m), b: spentIn(m) }; });

  const todayReport = S.dailyReports.find(r => r.id === U.todayISO());
  return `
    <div class="toolbar"><span class="hint">${todayReport ? `Today's report saved ${U.fmtWhen(todayReport.savedAt)}${todayReport.savedBy ? ` by ${esc(todayReport.savedBy)}` : ""}.` : "Today's report isn't saved yet."}</span><span class="spacer"></span><button class="btn primary" data-act="daily-report">Daily report</button></div>
    <div class="kpis">
      ${kpi(`Collected in ${fmtMonth(ym)}`, money(collected), `${S.payments.filter(p => (p.date || "").startsWith(ym)).length} payments`, "good", "#payments")}
      ${kpi("Owed by members", money(sum(owing, r => r.o.total)), `${owing.length} member${owing.length === 1 ? "" : "s"}`, owing.length ? "bad" : "", "#payments")}
      ${kpi("Renewals due", due.length, `ending in ${windowDays()} days or expired`, due.length ? "warn" : "", "#payments")}
      ${kpi("Active members", current, `with a valid membership today`)}
      ${kpi(`Expenses in ${fmtMonth(ym)}`, money(spent), `${bills.length} bill${bills.length === 1 ? "" : "s"} not paid yet`, "", "#expenses")}
      ${kpi("Net this month", money(collected - spent), "collected minus expenses", collected - spent >= 0 ? "good" : "bad")}
    </div>
    <div class="cols-3">
      <div class="grid" style="align-content:start">
        <div class="panel">
          <div class="panel-head"><h2>Renewals due</h2><div class="right"><a class="btn small" href="#payments">All</a></div></div>
          ${due.length ? renewalsTable(due.slice(0, 8)) + (due.length > 8 ? `<div class="panel-body hint">+ ${due.length - 8} more on the Payments page.</div>` : "") : empty("Nobody's membership is ending soon. 🎉")}
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Money owed</h2><div class="right"><a class="btn small" href="#payments" data-act="ui" data-id="payTab=owed">All</a></div></div>
          ${owing.length ? owedTable(owing.slice(0, 8)) : empty("Nobody owes anything.")}
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Income vs expenses</h2><div class="right legend"><span><i style="background:var(--brand)"></i>Income</span><span><i style="background:var(--muted);opacity:.55"></i>Expenses</span></div></div>
          <div class="panel-body">${barChart(chart)}</div>
        </div>
      </div>
      <div class="grid" style="align-content:start">
        ${hand.length ? `<div class="panel"><div class="panel-head"><h2>Kit to hand out</h2></div><ul class="list">${hand.map(h => `<li><div class="grow"><b>${esc(h.item)}</b><span class="sub">${esc(h.name)}</span></div><button class="btn small primary" data-act="handout-done" data-id="${esc(h.id)}">Handed out</button></li>`).join("")}</ul></div>` : ""}
        <div class="panel">
          <div class="panel-head"><h2>Bills this month</h2><div class="right"><a class="btn small" href="#expenses">Open</a></div></div>
          ${bills.length || unpaidInv.length ? `<ul class="list">${bills.map(b => `<li><div class="grow">${esc(b.b.name)}<span class="sub">due ${fmtDate(b.due)}${b.b.amount ? " · about " + money(b.b.amount) : ""}</span></div>${b.overdue ? badge("b-bad", "Late") : badge("b-info", b.state === "unpaid" ? "Unpaid" : "Due")}<button class="btn small" data-act="pay-bill" data-id="${esc(b.b.id)}" data-month="${ym}">Pay</button></li>`).join("")}
            ${unpaidInv.map(x => `<li><div class="grow">${esc(x.description || x.category)}<span class="sub">${esc(x.vendor || "")} · due ${fmtDate(x.dueDate)}</span></div><b>${money(x.amount)}</b><button class="btn small" data-act="pay-expense" data-id="${esc(x.id)}">Pay</button></li>`).join("")}</ul>`
            : (S.settings.bills || []).length ? empty("All bills for this month are paid.") : empty(`No monthly bills set up yet. <a href="#settings">Add rent, utilities…</a>`)}
        </div>
        ${eq.length || pauseEnded.length || outOfStock.length || newLeads || toAsk || unsent ? `<div class="panel"><div class="panel-head"><h2>Needs attention</h2></div><ul class="list">
          ${unsent ? `<li><div class="grow">${unsent} receipt photo${unsent === 1 ? "" : "s"}<span class="sub">not sent to the accountant yet</span></div><a class="btn small" href="#receipts" data-act="ui" data-id="rcFilter=unsent">Send</a></li>` : ""}
          ${newLeads ? `<li><div class="grow">${newLeads} new trial request${newLeads === 1 ? "" : "s"}<span class="sub">not contacted yet</span></div><a class="btn small" href="#leads">Open</a></li>` : ""}
          ${toAsk ? `<li><div class="grow">${toAsk} cancelled member${toAsk === 1 ? "" : "s"}<span class="sub">not asked yet if they want to renew</span></div><a class="btn small" href="#members" data-act="ui" data-id="mfilter=cancelled">Open</a></li>` : ""}
          ${eq.map(e => `<li><div class="grow">${esc(e.name)}<span class="sub">${e.condition === "Needs repair" ? "Needs repair" : "Service due " + fmtDate(e.serviceDue)}</span></div><button class="btn small" data-act="edit-eq" data-id="${esc(e.id)}">Update</button></li>`).join("")}
          ${outOfStock.length ? `<li><div class="grow">Out of stock<span class="sub">${esc(outOfStock.map(e => e.name).join(", "))}</span></div><a class="btn small" href="#equipment">Stock</a></li>` : ""}
          ${pauseEnded.map(m => `<li><div class="grow">${esc(m.name)}<span class="sub">Pause ended ${fmtDate(m.pauseUntil)}</span></div><button class="btn small" data-act="resume-member" data-id="${esc(m.id)}">Resume</button></li>`).join("")}
        </ul></div>` : ""}
        ${todaysClasses()}
        <div class="panel">
          <div class="panel-head"><h2>Recent activity</h2><div class="right"><a class="btn small" href="#activity">All</a></div></div>
          ${S.activity.length ? `<ul class="list feed">${S.activity.slice(0, 6).map(a => `<li><div class="grow">${esc(a.text)}<span class="sub">${esc(a.by || "")}</span></div><time>${U.fmtWhen(a.at)}</time></li>`).join("")}</ul>` : empty("Changes are logged here automatically.")}
        </div>
      </div>
    </div>`;
}

function renewalsTable(rows) {
  return `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Membership</th><th>Ends</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map(({ m, st }) => `<tr class="clickable" data-act="member" data-id="${esc(m.id)}">
      <td>${memberCell(m)}</td>
      <td>${esc(st.ms.plan || "Membership")}<span class="sub">${esc(st.ms.course || "")} · ${money(st.ms.packageAmount)}</span></td>
      <td>${fmtDate(st.ms.endDate)}</td>
      <td>${stateBadge(st)}</td>
      <td class="actions"><button class="btn small primary" data-act="renew" data-id="${esc(m.id)}">Renew</button> ${remindLink(m, "renewal")}</td></tr>`).join("")}
  </tbody></table></div>`;
}
function owedTable(rows) {
  return `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>For</th><th class="num">Owes</th><th></th></tr></thead><tbody>
    ${rows.map(({ m, o }) => `<tr class="clickable" data-act="member" data-id="${esc(m.id)}">
      <td>${memberCell(m)}</td>
      <td>${o.list.map(x => esc(x.ms.kind === "charge" ? x.ms.description : x.ms.plan || "Membership")).join(", ")}${o.list.length === 1 && o.list[0].ms.kind !== "charge" ? `<span class="sub">${fmtDate(o.list[0].ms.startDate)} – ${fmtDate(o.list[0].ms.endDate)}</span>` : ""}</td>
      <td class="num"><b>${money(o.total)}</b></td>
      <td class="actions"><button class="btn small primary" data-act="pay-member" data-id="${esc(m.id)}">Record payment</button> ${remindLink(m, "balance")}</td></tr>`).join("")}
  </tbody></table></div>`;
}
function todaysClasses() {
  const day = todayDay();
  const now = U.nowTime();
  const list = (S.settings.schedule || []).filter(s => s.day === day).sort((a, b) => a.from.localeCompare(b.from));
  if (!list.length) return "";
  return `<div class="panel"><div class="panel-head"><h2>Today's classes</h2><div class="right"><a class="btn small" href="#schedule">Week</a></div></div>
    <ul class="list">${list.map(s => `<li${s.from <= now && now < s.to ? ' style="background:var(--brand-soft)"' : ""}><div class="grow"><b>${esc(s.class)}</b><span class="sub">${esc(s.group || "")}</span></div><span class="hint">${esc(s.from)}–${esc(s.to)}</span></li>`).join("")}</ul></div>`;
}

function viewMembers() {
  const { mq, mfilter, mprog } = S.ui;
  const all = S.members.map(m => ({ m, st: stateOf(m), o: owedOf(m) }));
  const groups = {
    current: r => isCurrent(r.st), expired: r => r.st.state === "expired", none: r => r.st.state === "none",
    paused: r => r.st.state === "paused", cancelled: r => r.st.state === "cancelled", owing: r => r.o.total > 0 && r.st.state !== "cancelled", all: () => true
  };
  const n = k => all.filter(groups[k]).length;
  const q = mq.toLowerCase();
  const rows = all.filter(groups[mfilter] || groups.all)
    .filter(r => !mprog || (r.m.programs || []).includes(mprog))
    .filter(r => !q || [r.m.name, r.m.phone, r.m.email, r.m.guardianName, r.m.guardianPhone].some(v => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => byName(a.m, b.m));
  const cancelled = mfilter === "cancelled" ? S.members.filter(m => m.status === "cancelled") : [];
  const count = fn => cancelled.filter(fn).length;
  const askHelp = mfilter === "cancelled" && cancelled.length ? `<div class="callout info">Send each cancelled member a WhatsApp message to check if they want to cancel for sure or renew, then note their answer on their page.
      <b>${count(m => !m.cancelAskedAt && !m.cancelAnswer)}</b> not asked yet · <b>${count(m => m.cancelAskedAt && !m.cancelAnswer)}</b> waiting for a reply · <b>${count(m => m.cancelAnswer === ANSWERS.renew)}</b> want to renew · <b>${count(m => m.cancelAnswer === ANSWERS.cancel)}</b> confirmed.
      ${count(m => !U.waNumber(m.phone || m.guardianPhone)) ? `${count(m => !U.waNumber(m.phone || m.guardianPhone))} have no phone number yet: open them and tap Edit to add one.` : ""}</div>` : "";
  const actions = (m, st, o) => m.status === "cancelled"
    ? `${remindLink(m, "cancel", m.cancelAskedAt ? "Ask again" : "Ask: cancel or renew?") || `<button class="btn small" data-act="edit-member" data-id="${esc(m.id)}">Add phone</button>`}<button class="btn small" data-act="renew" data-id="${esc(m.id)}">Re-join</button>`
    : `<button class="btn small primary" data-act="renew" data-id="${esc(m.id)}">${st.ms ? "Renew" : "Start"}</button>${o.total ? `<button class="btn small" data-act="pay-member" data-id="${esc(m.id)}">Pay</button>` : ""}`;
  return `
    <div class="toolbar">
      <input type="search" id="m-search" placeholder="Search name or phone…" value="${esc(mq)}" data-ui="mq">
      <div class="seg">${seg("mfilter", "current", `Active (${n("current")})`)}${seg("mfilter", "expired", `Expired (${n("expired")})`)}${seg("mfilter", "owing", `Owing (${n("owing")})`)}${seg("mfilter", "paused", `Paused (${n("paused")})`)}${seg("mfilter", "cancelled", `Cancelled (${n("cancelled")})`)}${seg("mfilter", "all", `All (${all.length})`)}</div>
      <select data-ui="mprog" id="m-prog" aria-label="Program">${options(PROGRAMS, mprog, { blank: "All programs" })}</select>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="members">Export to Excel</button>
      <button class="btn primary" data-act="new-member">+ Add member</button>
    </div>
    ${askHelp}
    <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>Member</th><th>Programs</th><th>Joined</th><th>Membership</th><th>Status</th><th class="num">Owes</th><th>Last payment</th><th></th></tr></thead><tbody>
      ${rows.map(({ m, st, o }) => {
        const last = paymentsOf(m.id)[0];
        return `<tr class="clickable" data-act="member" data-id="${esc(m.id)}">
          <td>${memberCell(m)}</td>
          <td>${esc((m.programs || []).join(", ") || "—")}</td>
          <td>${fmtDate(m.joinDate)}</td>
          <td>${st.ms ? `${esc(st.ms.plan || "Membership")}<span class="sub">${fmtDate(st.ms.startDate)} – ${fmtDate(st.ms.endDate)}</span>` : "—"}</td>
          <td>${stateBadge(st)}${m.status === "cancelled" ? ` ${askState(m)}${m.cancelReason ? `<span class="sub">${esc(m.cancelReason)}</span>` : ""}` : ""}</td>
          <td class="num">${o.total ? `<b style="color:var(--bad)">${money(o.total)}</b>` : "—"}</td>
          <td>${last ? `${fmtDate(last.date)}<span class="sub">${money(last.amount)}</span>` : "—"}</td>
          <td class="actions">${actions(m, st, o)}</td></tr>`;
      }).join("")}</tbody></table></div>` : empty(S.members.length ? "No members match." : "No members yet.")}</div>`;
}

function viewPayments() {
  const tab = S.ui.payTab;
  const due = renewalsDue();
  const owing = owingList();
  const ym = S.ui.payMonth;
  const tabs = `<div class="seg" style="margin-bottom:14px">${seg("payTab", "renewals", `Renewals due (${due.length})`)}${seg("payTab", "owed", `Owed (${owing.length})`)}${seg("payTab", "log", "Payment log")}</div>`;
  const head = `<div class="kpis">
      ${kpi(`Collected in ${fmtMonth(U.thisMonth())}`, money(incomeIn(U.thisMonth())), "all payments", "good")}
      ${kpi("Owed by members", money(sum(owing, r => r.o.total)), `${owing.length} members`, owing.length ? "bad" : "")}
      ${kpi("Ending soon", due.filter(r => r.st.state === "ending").length, `in the next ${windowDays()} days`, "warn")}
      ${kpi("Expired (last 30 days)", due.filter(r => r.st.state === "expired").length, "not renewed yet", "bad")}
    </div>`;
  let body = "";
  if (tab === "renewals") {
    body = `<div class="panel"><div class="panel-head"><h2>Renewals due</h2><span class="hint">Memberships ending in the next ${windowDays()} days or expired in the last 30. Older ones are under Members → Expired.</span><div class="right"><button class="btn small primary" data-act="new-membership">+ New membership</button></div></div>
      ${due.length ? renewalsTable(due) : empty("Nothing due. Everyone's memberships are up to date.")}</div>`;
  } else if (tab === "owed") {
    body = `<div class="panel"><div class="panel-head"><h2>Money owed by members</h2><span class="hint">Unpaid parts of memberships, kit and other charges. Cancelled members aren't counted.</span><div class="right"><button class="btn small" data-act="new-charge">+ Kit or other charge</button></div></div>
      ${owing.length ? owedTable(owing) : empty("Nobody owes anything.")}</div>`;
  } else {
    const q = S.ui.payQ.toLowerCase();
    const photoOf = receiptsByPayment();
    const pays = S.payments.filter(p => (p.date || "").startsWith(ym))
      .filter(p => !q || [p.memberName, p.payerName, p.bookNo, p.receipt].some(v => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.receipt || "").localeCompare(a.receipt || ""));
    const byMethod = {};
    pays.forEach(p => { byMethod[p.method || "Not recorded"] = (byMethod[p.method || "Not recorded"] || 0) + num(p.amount); });
    body = `<div class="toolbar">
        <button class="btn" data-act="ui" data-id="payMonth=${U.addMonths(ym, -1)}" aria-label="Previous month">‹</button>
        <input type="month" id="pay-month" value="${ym}" data-ui="payMonth" aria-label="Month">
        <button class="btn" data-act="ui" data-id="payMonth=${U.addMonths(ym, 1)}" aria-label="Next month">›</button>
        <input type="search" id="pay-q" placeholder="Search name or receipt no.…" value="${esc(S.ui.payQ)}" data-ui="payQ">
        <span class="spacer"></span>
        <button class="btn" data-act="export" data-id="payments-month">Export month</button>
        <button class="btn" data-act="export" data-id="payments">Export all</button>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Payments in ${fmtMonth(ym)}: ${money(sum(pays, p => p.amount))}</h2><span class="hint">${Object.entries(byMethod).map(([k, v]) => `${esc(k)} ${money(v)}`).join(" · ")}</span></div>
        ${pays.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>From</th><th>Date</th><th>Type</th><th>For</th><th>Method</th><th class="num">Amount</th><th></th></tr></thead><tbody>
          ${pays.map(p => { const ms = p.membershipId ? membershipById(p.membershipId) : null; const ph = photoOf.get(p.id); return `<tr${p.memberId ? ` class="clickable" data-act="member" data-id="${esc(p.memberId)}"` : ""}><td><b>${esc(p.memberName || p.payerName || "—")}</b>${payNo(p) ? `<span class="sub">${esc(payNo(p))}</span>` : ""}</td><td>${fmtDate(p.date)}</td><td>${esc(p.type || "Membership")}</td>
            <td>${ms ? esc(ms.kind === "charge" ? ms.description : ms.plan || "Membership") : esc(p.note && !/^from /.test(p.note) ? p.note : "—")}</td><td>${esc(p.method || "")}</td><td class="num">${money(p.amount)}</td>
            <td class="actions">${ph ? `<button class="btn small" data-act="rc-open" data-id="${esc(ph.id)}">Photo</button>` : ""}<button class="btn small" data-act="receipt" data-id="${esc(p.id)}">Receipt</button><button class="btn small" data-act="edit-payment" data-id="${esc(p.id)}">Edit</button><button class="btn small danger" data-act="del-payment" data-id="${esc(p.id)}" aria-label="Delete payment">✕</button></td></tr>`; }).join("")}
        </tbody><tfoot><tr><td colspan="5">Total</td><td class="num">${money(sum(pays, p => p.amount))}</td><td></td></tr></tfoot></table></div>` : empty("No payments in this month.")}
      </div>`;
  }
  return `<div class="toolbar"><span class="spacer"></span><a class="btn" href="#receipts">Receipt photos</a><button class="btn" data-act="new-charge">+ Kit / other charge</button><button class="btn primary" data-act="new-payment">+ Record payment</button></div>${head}${tabs}${body}`;
}

const payNo = p => [p.bookNo ? `No. ${p.bookNo}` : "", p.receipt].filter(Boolean).join(" · ");
// Voucher photos by the payment or expense they belong to.
function receiptsByPayment() {
  const map = new Map();
  for (const r of S.receipts) for (const k of [r.paymentId, r.expenseId]) if (k && !map.has(k)) map.set(k, r);
  return map;
}

function viewReceipts() {
  if (!S.loaded.has("receipts")) return empty("Loading receipt photos…");
  const f = S.ui.rcFilter, t = S.ui.rcType;
  const ofType = S.receipts.filter(r => !t || (r.kind || "in") === t);
  const unsent = ofType.filter(r => !r.sentAt);
  const rows = f === "unsent" ? unsent : f === "sent" ? ofType.filter(r => r.sentAt) : ofType;
  const sel = S.ui.rcSel.filter(id => S.receipts.some(r => r.id === id));
  const toSend = sel.length ? sel.length : unsent.length;
  const mb = sum(S.receipts, r => r.bytes) / 1048576;
  const link = safeLink(S.settings.accountantLink);
  const kindBadge = r => (r.kind || "in") === "out" ? badge("b-warn", "Payment voucher") : badge("b-info", "Receipt voucher");
  return `
    <div class="toolbar">
      <div class="seg">${seg("rcFilter", "unsent", `Not sent yet (${unsent.length})`)}${seg("rcFilter", "sent", "Sent")}${seg("rcFilter", "all", `All (${ofType.length})`)}</div>
      <select data-ui="rcType" id="rc-type" aria-label="Type">${options([["", "Receipt & payment vouchers"], ["in", "Receipt vouchers (money in)"], ["out", "Payment vouchers (money out)"]], t)}</select>
      <span class="spacer"></span>
      ${sel.length ? `<button class="btn" data-act="rc-clear">Clear selection (${sel.length})</button>` : ""}
      ${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open ${esc(S.settings.accountantName || "accountant group")}</a>` : ""}
      <button class="btn primary" data-act="rc-send"${toSend ? "" : " disabled"}>Send ${toSend ? `${toSend} ` : ""}to the accountant</button>
    </div>
    <div class="dropzone-wrap">
      <span class="hint">New photos are:</span>
      <div class="seg">${seg("rcKind", "in", "Receipts (سند قبض)")}${seg("rcKind", "out", "Payments (سند صرف)")}</div>
      <label class="dropzone" for="rc-file">
        ${icon("receipts")}<b>Drag ${S.ui.rcKind === "out" ? "payment voucher" : "receipt voucher"} photos here</b>
        <span>or tap to take a photo or choose some. You can also drop photos anywhere in the admin.</span>
        <input type="file" id="rc-file" accept="image/*" multiple hidden data-change="rc-files">
      </label>
    </div>
    ${link ? "" : `<div class="callout warn">Add the accountant's WhatsApp group link in <a href="#settings">Settings → Receipts & accountant</a>, so "Send" can open the group.</div>`}
    <div class="panel">
      <div class="panel-head"><h2>${f === "unsent" ? "Not sent to the accountant yet" : f === "sent" ? "Sent to the accountant" : "All voucher photos"}</h2><span class="hint">Tap a photo to fill in the number, amount and name from the voucher. Tick photos to send only those.</span></div>
      ${rows.length ? `<div class="rc-grid">${rows.map(r => `<div class="rc-card${sel.includes(r.id) ? " on" : ""}">
          <button type="button" class="rc-thumb" data-act="rc-open" data-id="${esc(r.id)}" aria-label="Open voucher ${esc(r.number || "")}"><img src="${esc(r.thumb)}" alt="" loading="lazy"></button>
          <label class="rc-check" aria-label="Select"><input type="checkbox" data-change="rc-sel" data-id="${esc(r.id)}"${sel.includes(r.id) ? " checked" : ""}></label>
          ${r.sentAt ? `<span class="rc-sent">${badge("b-ok", "Sent")}</span>` : ""}
          <div class="rc-meta">${kindBadge(r)}<br><b>${r.number ? `No. ${esc(r.number)}` : "No number yet"}</b>${r.amount ? ` · ${money(r.amount)}` : ""}<span class="sub">${esc(r.name || r.memberName || r.being || r.note || "—")}</span><span class="sub">${fmtDate(r.date)}${r.sentAt ? ` · sent ${fmtDate(r.sentAt)}` : ""}</span></div>
        </div>`).join("")}</div>` : empty(f === "unsent" ? "Everything has been sent to the accountant." : "No voucher photos yet.")}
      ${S.receipts.length ? `<div class="panel-body hint">The photos use ${mb < 1 ? "less than 1" : `about ${Math.round(mb)}`} MB of the database's free 1 GB${S.receipts.length >= 400 ? " (counting the latest 400)" : ""}.</div>` : ""}
    </div>`;
}

function viewExpenses() {
  const { expMonth: ym, expCat } = S.ui;
  const photoOf = receiptsByPayment();
  const bills = billRows(ym);
  const list = S.expenses.filter(x => (x.date || x.dueDate || "").startsWith(ym) || (x.period === ym)).filter(x => !expCat || x.category === expCat)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const paid = list.filter(x => x.status !== "unpaid");
  const unpaidAll = S.expenses.filter(x => x.status === "unpaid").sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
  const byCat = {};
  paid.forEach(x => { byCat[x.category] = (byCat[x.category] || 0) + num(x.amount); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  return `
    <div class="toolbar">
      <button class="btn" data-act="ui" data-id="expMonth=${U.addMonths(ym, -1)}" aria-label="Previous month">‹</button>
      <input type="month" id="exp-month" value="${ym}" data-ui="expMonth" aria-label="Month">
      <button class="btn" data-act="ui" data-id="expMonth=${U.addMonths(ym, 1)}" aria-label="Next month">›</button>
      <select id="exp-cat" data-ui="expCat" aria-label="Category">${options(EXP_CATS, expCat, { blank: "All categories" })}</select>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="expenses">Export to Excel</button>
      <button class="btn primary" data-act="new-expense">+ Add expense</button>
    </div>
    <div class="kpis">
      ${kpi(`Paid out in ${fmtMonth(ym)}`, money(sum(paid, x => x.amount)), `${paid.length} entries`)}
      ${kpi("Unpaid bills & invoices", money(sum(unpaidAll, x => x.amount)), `${unpaidAll.length} waiting`, unpaidAll.length ? "bad" : "")}
      ${kpi("Monthly bills not entered", bills.filter(b => b.state === "missing").length, `of ${bills.length} recurring bills`, bills.some(b => b.overdue) ? "warn" : "")}
      ${kpi("Biggest cost", cats[0] ? esc(cats[0][0].split(" (")[0]) : "—", cats[0] ? money(cats[0][1]) : "")}
    </div>
    <div class="cols-2" style="margin-bottom:16px">
      <div class="panel">
        <div class="panel-head"><h2>Monthly bills: ${fmtMonth(ym)}</h2><div class="right"><a class="btn small" href="#settings">Edit bills</a></div></div>
        ${bills.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Bill</th><th>Due</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
          ${bills.map(b => `<tr><td><b>${esc(b.b.name)}</b><span class="sub">${esc(b.b.category)}</span></td><td>${fmtDate(b.due)}</td>
            <td>${b.state === "paid" ? badge("b-ok", "Paid") : b.overdue ? badge("b-bad", b.state === "unpaid" ? "Unpaid · late" : "Late") : badge("b-info", b.state === "unpaid" ? "Unpaid" : "Due")}</td>
            <td class="num">${b.entry ? money(b.entry.amount) : b.b.amount ? `<span class="hint">≈ ${money(b.b.amount)}</span>` : "<span class=hint>varies</span>"}</td>
            <td class="actions">${b.state === "paid" ? `<button class="btn small" data-act="edit-expense" data-id="${esc(b.entry.id)}">View</button>` : b.state === "unpaid" ? `<button class="btn small primary" data-act="pay-expense" data-id="${esc(b.entry.id)}">Mark paid</button>` : `<button class="btn small primary" data-act="pay-bill" data-id="${esc(b.b.id)}" data-month="${ym}">Enter</button>`}</td></tr>`).join("")}
        </tbody></table></div>` : empty(`Add recurring bills (rent, electricity & water, phone, salaries) in <a href="#settings">Settings</a>. Each month they appear here to tick off.`)}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Unpaid bills & invoices</h2></div>
        ${unpaidAll.length ? `<ul class="list">${unpaidAll.map(x => `<li><div class="grow"><b>${esc(x.description || x.category)}</b><span class="sub">${esc(x.vendor || x.category)} · due ${fmtDate(x.dueDate)}</span></div>${x.dueDate && x.dueDate < U.todayISO() ? badge("b-bad", "Late") : ""}<b>${money(x.amount)}</b><button class="btn small primary" data-act="pay-expense" data-id="${esc(x.id)}">Pay</button></li>`).join("")}</ul>` : empty("Nothing waiting to be paid.")}
        ${cats.length ? `<div class="panel-head" style="border-top:1px solid var(--line)"><h2>Spent by category</h2></div><ul class="list">${cats.map(([c, v]) => `<li><div class="grow">${esc(c)}</div><b>${money(v)}</b></li>`).join("")}</ul>` : ""}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Expense log: ${fmtMonth(ym)}</h2></div>
      ${list.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Description</th><th>Date</th><th>Category</th><th>Paid with</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
        ${list.map(x => { const ph = photoOf.get(x.id); return `<tr class="clickable" data-act="edit-expense" data-id="${esc(x.id)}"><td><b>${esc(x.description || x.category)}</b>${x.vendor || x.voucherNo ? `<span class="sub">${esc([x.vendor, x.voucherNo ? `Voucher no. ${x.voucherNo}` : ""].filter(Boolean).join(" · "))}</span>` : ""}</td><td>${fmtDate(x.date || x.dueDate)}</td><td>${esc(x.category)}</td><td>${esc(x.status === "unpaid" ? "" : x.method || "")}</td>
          <td>${x.status === "unpaid" ? badge("b-bad", "Unpaid") : badge("b-ok", "Paid")}</td><td class="num">${money(x.amount)}</td>
          <td class="actions">${ph ? `<button class="btn small" data-act="rc-open" data-id="${esc(ph.id)}">Photo</button>` : ""}${x.status === "unpaid" ? `<button class="btn small primary" data-act="pay-expense" data-id="${esc(x.id)}">Pay</button>` : ""}<button class="btn small danger" data-act="del-expense" data-id="${esc(x.id)}" aria-label="Delete expense">✕</button></td></tr>`; }).join("")}
      </tbody><tfoot><tr><td colspan="5">Total paid</td><td class="num">${money(sum(paid, x => x.amount))}</td><td></td></tr></tfoot></table></div>` : empty("No expenses in this month.")}
    </div>`;
}

function viewSchedule() {
  const sched = S.settings.schedule || [];
  const day = S.ui.schedDay;
  const now = U.nowTime(), today = todayDay();
  const counts = Object.fromEntries(DAYS.map(([d]) => [d, sched.filter(s => s.day === d).length]));
  const grpBadge = g => badge(g === "Ladies" ? "b-brand" : g === "Kids" ? "b-info" : "b-mute", g || "—");
  if (!sched.length) return `<div class="panel">${empty(`No classes yet. Add the timetable in <a href="#settings">Settings → Class schedule</a>.`)}</div>`;
  if (day === "week") {
    const times = [...new Set(sched.map(s => `${s.from}–${s.to}`))].sort();
    const shownDays = DAYS.filter(([d]) => counts[d]);
    return `<div class="toolbar"><div class="seg">${DAYS.filter(([d]) => counts[d]).map(([d]) => seg("schedDay", d, d)).join("")}${seg("schedDay", "week", "Whole week")}</div></div>
      <div class="panel"><div class="table-wrap"><table class="t week"><thead><tr><th>Time</th>${shownDays.map(([d, l]) => `<th>${l}</th>`).join("")}</tr></thead><tbody>
      ${times.map(t => `<tr><td><b>${esc(t)}</b></td>${shownDays.map(([d]) => { const s = sched.find(x => x.day === d && `${x.from}–${x.to}` === t); return `<td>${s ? `${esc(s.class)}<span class="sub">${esc(s.group || "")}</span>` : ""}</td>`; }).join("")}</tr>`).join("")}
      </tbody></table></div></div>`;
  }
  const list = sched.filter(s => s.day === day).sort((a, b) => a.from.localeCompare(b.from));
  return `<div class="toolbar"><div class="seg">${DAYS.filter(([d]) => counts[d]).map(([d]) => seg("schedDay", d, d === today ? `${d} · today` : d)).join("")}${seg("schedDay", "week", "Whole week")}</div><span class="spacer"></span><a class="btn" href="#settings">Edit timetable</a></div>
    <div class="panel"><div class="panel-head"><h2>${esc((DAYS.find(x => x[0] === day) || [day, day])[1])}</h2><span class="hint">${list.length} classes</span></div>
    ${list.length ? `<ul class="list">${list.map(s => {
      const live = day === today && s.from <= now && now < s.to;
      return `<li${live ? ' style="background:var(--brand-soft)"' : ""}><div style="width:96px;flex:none"><b>${esc(s.from)}</b><span class="sub">to ${esc(s.to)}</span></div><div class="grow"><b>${esc(s.class)}</b>${live ? ` ${badge("b-ok", "On now")}` : ""}</div>${grpBadge(s.group)}</li>`;
    }).join("")}</ul>` : empty("No classes on this day.")}</div>`;
}

function viewEquipment() {
  const { eqQ, eqCond } = S.ui;
  const q = eqQ.toLowerCase();
  const rows = S.equipment.filter(e => !eqCond || (eqCond === "stock" ? e.forSale : e.condition === eqCond))
    .filter(e => !q || [e.name, e.category, e.supplier, e.location].some(v => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => (b.forSale ? 1 : 0) - (a.forSale ? 1 : 0) || (a.category || "").localeCompare(b.category || "") || (a.name || "").localeCompare(b.name || ""));
  const live = S.equipment.filter(e => e.condition !== "Retired");
  const soon = U.addDays(U.todayISO(), 14);
  return `
    <div class="toolbar">
      <input type="search" id="eq-q" placeholder="Search equipment or stock…" value="${esc(eqQ)}" data-ui="eqQ">
      <select id="eq-cond" data-ui="eqCond" aria-label="Filter">${options([["stock", "Stock for sale"], ...EQ_COND.map(c => [c, c])], eqCond, { blank: "Everything" })}</select>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="equipment">Export to Excel</button>
      <button class="btn primary" data-act="new-eq">+ Add item</button>
    </div>
    <div class="kpis">
      ${kpi("Stock for sale", sum(S.equipment.filter(e => e.forSale), e => e.qty), `${S.equipment.filter(e => e.forSale && num(e.qty) <= 0).length} items out of stock`, S.equipment.some(e => e.forSale && num(e.qty) <= 0) ? "warn" : "")}
      ${kpi("Club equipment", sum(live.filter(e => !e.forSale), e => e.qty || 1), `${live.filter(e => !e.forSale).length} lines`)}
      ${kpi("Needs repair", S.equipment.filter(e => e.condition === "Needs repair").length, "", S.equipment.some(e => e.condition === "Needs repair") ? "bad" : "")}
      ${kpi("Service due (14 days)", live.filter(e => e.serviceDue && e.serviceDue <= soon).length, "", "warn")}
    </div>
    <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Item</th><th>Category</th><th class="num">Qty</th><th>Condition</th><th class="num">Price / cost</th><th>Next service</th><th></th></tr></thead><tbody>
      ${rows.map(e => `<tr><td><b>${esc(e.name)}</b>${e.forSale ? ` ${num(e.qty) <= 0 ? badge("b-bad", "Out of stock") : badge("b-brand", "For sale")}` : ""}${e.location ? `<span class="sub">${esc(e.location)}</span>` : ""}</td><td>${esc(e.category || "")}</td><td class="num"><b>${esc(e.qty ?? 1)}</b></td>
        <td><select data-change="eq-cond" data-id="${esc(e.id)}" aria-label="Condition of ${esc(e.name)}" style="width:auto;padding:4px 8px">${options(EQ_COND, e.condition)}</select></td>
        <td class="num">${e.salePrice ? money(e.salePrice) : e.unitCost ? money(e.unitCost) : "—"}</td>
        <td>${e.serviceDue ? (e.serviceDue <= soon ? badge("b-warn", fmtDate(e.serviceDue)) : fmtDate(e.serviceDue)) : "—"}</td>
        <td class="actions">${e.forSale ? `<button class="btn small primary" data-act="sell-eq" data-id="${esc(e.id)}"${num(e.qty) <= 0 ? " disabled" : ""}>Sell</button><button class="btn small" data-act="restock-eq" data-id="${esc(e.id)}">+ Stock</button>` : `<button class="btn small" data-act="repair-eq" data-id="${esc(e.id)}">Log repair</button>`}<button class="btn small" data-act="edit-eq" data-id="${esc(e.id)}">Edit</button></td></tr>`).join("")}
    </tbody></table></div>` : empty(S.equipment.length ? "Nothing matches." : "Track kit stock (gloves, mouth guards, shin guards…) and club equipment here.")}</div>
    <p class="hint" style="margin-top:10px">"Sell" records the sale as a charge on the member (paid or owed) and takes one off the stock.</p>`;
}

function viewLeads() {
  const f = S.ui.leadFilter;
  const closed = ["Not interested", "Old enquiry"];
  const match = l => f === "all" || (f === "open" ? LEAD_OPEN.includes(l.status || "New") : f === "closed" ? closed.includes(l.status) : l.status === f);
  const rows = S.leads.filter(match).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const n = s => S.leads.filter(l => (s === "open" ? LEAD_OPEN.includes(l.status || "New") : s === "closed" ? closed.includes(l.status) : l.status === s)).length;
  const lseg = (v, l) => `<button class="${f === v ? "on" : ""}" data-act="ui" data-id="leadFilter=${v}">${l}</button>`;
  return `
    <div class="toolbar">
      <div class="seg">${lseg("open", `Open (${n("open")})`)}${lseg("Joined", `Joined (${n("Joined")})`)}${lseg("closed", `Closed (${n("closed")})`)}${lseg("all", "All")}</div>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="leads">Export to Excel</button>
      <button class="btn primary" data-act="new-lead">+ Add request</button>
    </div>
    <div class="kpis">
      ${kpi("New (not contacted)", n("New"), "walk-ins, calls and messages", n("New") ? "warn" : "")}
      ${kpi("Trials booked", n("Trial booked"))}
      ${kpi("Trial done", n("Attended trial"), "follow up to sign them up")}
      ${kpi("Joined", n("Joined"))}
    </div>
    <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Received</th><th>Program</th><th>Status</th><th>Trial date</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 300).map(l => {
        const wa = U.waLink(l.phone, `Hi ${firstName(l.name)}, thanks for your interest in ${S.settings.clubName}! When would you like to come for your free ${l.program && l.program !== "Not sure yet" ? l.program + " " : ""}trial class?`);
        return `<tr><td><b>${esc(l.name)}</b><span class="sub">${esc(l.phone || "")}</span>${l.message ? `<span class="sub">“${esc(l.message)}”</span>` : ""}</td><td>${fmtDate(l.createdAt)}</td>
        <td>${esc(l.program || "—")}${l.ageGroup || l.preferredTime ? `<span class="sub">${esc([l.ageGroup, l.preferredTime].filter(Boolean).join(" · "))}</span>` : ""}</td>
        <td><select data-change="lead-status" data-id="${esc(l.id)}" aria-label="Status of ${esc(l.name)}" style="width:auto;padding:4px 8px">${options(LEAD_STATUS, l.status || "New")}</select></td>
        <td>${l.trialDate ? fmtDate(l.trialDate) : "—"}</td>
        <td class="actions">${wa ? `<a class="btn small wa" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}${l.status !== "Joined" ? `<button class="btn small primary" data-act="convert-lead" data-id="${esc(l.id)}">Make member</button>` : ""}<button class="btn small" data-act="edit-lead" data-id="${esc(l.id)}">Edit</button></td></tr>`;
      }).join("")}
    </tbody></table></div>${rows.length > 300 ? `<div class="panel-body hint">Showing the newest 300 of ${rows.length}.</div>` : ""}` : empty(S.leads.length ? "Nothing in this list." : "Log people who ask about a free trial (walk-ins, calls, WhatsApp, Instagram) so nobody is forgotten.")}</div>`;
}

function lastVisits() {
  const last = {};
  for (const a of S.attendance) if (!last[a.memberId] || a.date > last[a.memberId]) last[a.memberId] = a.date;
  return last;
}

function viewAttendance() {
  const d = S.ui.attDate;
  const today = U.todayISO();
  const day = S.attendance.filter(a => a.date === d).sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  const weekStart = U.addDays(today, -((new Date().getDay() + 6) % 7));
  const last = lastVisits();
  const cutoff = U.addDays(today, -14);
  const away = S.attendance.length ? S.members.filter(m => isCurrent(stateOf(m)) && (m.joinDate || "") <= cutoff && (!last[m.id] || last[m.id] < cutoff))
    .sort((a, b) => (last[a.id] || "").localeCompare(last[b.id] || "")) : [];
  return `
    <div class="toolbar">
      <button class="btn" data-act="ui" data-id="attDate=${U.addDays(d, -1)}" aria-label="Previous day">‹</button>
      <input type="date" id="att-date" value="${d}" data-ui="attDate" aria-label="Day">
      <button class="btn" data-act="ui" data-id="attDate=${U.addDays(d, 1)}" aria-label="Next day">›</button>
      ${d !== today ? `<button class="btn" data-act="ui" data-id="attDate=${today}">Today</button>` : ""}
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="attendance">Export to Excel</button>
      <button class="btn primary" data-act="checkin">Check members in</button>
    </div>
    <div class="kpis">
      ${kpi(d === today ? "Checked in today" : `Checked in ${fmtDate(d)}`, day.length)}
      ${kpi("This week", S.attendance.filter(a => a.date >= weekStart && a.date <= today).length, "check-ins since Monday")}
      ${kpi(`In ${fmtMonth(U.thisMonth())}`, S.attendance.filter(a => a.date.startsWith(U.thisMonth())).length, "check-ins")}
      ${kpi("Not seen for 14+ days", away.length, "active members", away.length ? "warn" : "")}
    </div>
    <div class="cols-2">
      <div class="panel">
        <div class="panel-head"><h2>${d === today ? "Today" : fmtDate(d)}</h2></div>
        ${day.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Time</th><th>Class</th><th></th></tr></thead><tbody>
          ${day.map(a => `<tr><td><b>${esc(a.memberName || memberById(a.memberId)?.name || "—")}</b></td><td>${esc(a.time || "")}</td><td>${esc(a.program || "")}</td><td class="actions"><button class="btn small danger" data-act="del-att" data-id="${esc(a.id)}" aria-label="Remove check-in">✕</button></td></tr>`).join("")}
        </tbody></table></div>` : empty("No check-ins on this day.")}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Haven't trained in 14+ days</h2><span class="hint">A friendly message often keeps them coming.</span></div>
        ${S.attendance.length ? (away.length ? `<ul class="list">${away.map(m => {
          const wa = U.waLink(m.phone || m.guardianPhone, `Hi ${greetName(m)}, we've missed you at ${S.settings.clubName}! Hope all is well. See you on the mat soon?`);
          return `<li><div class="grow"><button class="linkish" data-act="member" data-id="${esc(m.id)}">${esc(m.name)}</button><span class="sub">${last[m.id] ? "Last visit " + fmtDate(last[m.id]) : "No visits recorded"}</span></div>${wa ? `<a class="btn small wa" href="${esc(wa)}" target="_blank" rel="noopener">Message</a>` : ""}</li>`;
        }).join("")}</ul>` : empty("Everyone has trained in the last two weeks.")) : empty("Start checking members in and this list fills itself.")}
      </div>
    </div>`;
}

function monthStats(m) {
  const ps = S.payments.filter(p => (p.date || "").startsWith(m));
  const mem = sum(ps.filter(p => (p.type || "Membership") === "Membership"), p => p.amount);
  const inc = sum(ps, p => p.amount), exp = spentIn(m);
  return { m, mem, other: inc - mem, inc, exp, net: inc - exp, joined: S.members.filter(x => (x.joinDate || "").startsWith(m)).length, cancelled: S.members.filter(x => x.status === "cancelled" && (x.cancelDate || "").startsWith(m)).length };
}

function cashBook(ym, method) {
  const ins = S.payments.filter(p => (p.date || "").startsWith(ym)).map(p => ({ date: p.date, text: p.memberName || p.payerName || "—", sub: p.type, method: p.method || "Not recorded", inAmt: num(p.amount), outAmt: 0 }));
  const outs = S.expenses.filter(x => x.status !== "unpaid" && (x.date || "").startsWith(ym)).map(x => ({ date: x.date, text: x.description || x.category, sub: x.category, method: x.method || "Cash", inAmt: 0, outAmt: num(x.amount) }));
  const rows = [...ins, ...outs].filter(r => !method || r.method === method).sort((a, b) => (a.date || "").localeCompare(b.date || "") || b.inAmt - a.inAmt);
  let bal = 0;
  rows.forEach(r => { bal = round(bal + r.inAmt - r.outAmt); r.bal = bal; });
  return rows;
}

function viewReports() {
  const y = S.ui.repYear, ym = S.ui.repMonth;
  const stats = Array.from({ length: 12 }, (_, i) => monthStats(`${y}-${U.pad(i + 1)}`));
  const tot = k => sum(stats, s => s[k]);
  const years = [...new Set([U.todayISO().slice(0, 4), ...S.payments.map(p => (p.date || "").slice(0, 4)), ...S.expenses.map(x => (x.date || "").slice(0, 4))].filter(Boolean))].sort().reverse();
  const group = (rows, key, val) => { const g = {}; rows.forEach(r => { const k = key(r) || "—"; g[k] = (g[k] || 0) + num(val(r)); }); return Object.entries(g).sort((a, b) => b[1] - a[1]); };
  const mp = S.payments.filter(p => (p.date || "").startsWith(ym));
  const me = S.expenses.filter(x => x.status !== "unpaid" && (x.date || "").startsWith(ym));
  const byProg = group(mp.filter(p => p.memberId), p => { const ms = p.membershipId ? membershipById(p.membershipId) : null; return ms?.course || (memberById(p.memberId)?.programs || [])[0] || "Other"; }, p => p.amount);
  const cancels = S.members.filter(m => m.status === "cancelled" && (m.cancelDate || "").startsWith(ym));
  const reasons = group(S.members.filter(m => m.status === "cancelled"), m => m.cancelReason, () => 1);
  const book = cashBook(ym, S.ui.cashMethod);
  const mini = (title, rows, fmt = money) => `<div class="panel"><div class="panel-head"><h2>${title}</h2></div>${rows.length ? `<ul class="list">${rows.map(([k, v]) => `<li><div class="grow">${esc(k)}</div><b>${fmt(v)}</b></li>`).join("")}</ul>` : empty("Nothing yet.")}</div>`;
  return `
    <div class="toolbar">
      <label for="rep-year" style="margin:0">Year</label>
      <select id="rep-year" data-ui="repYear" style="width:auto">${options(years, y)}</select>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="year">Export year summary</button>
      <button class="btn primary" data-act="daily-report">Daily report</button>
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h2>Daily reports</h2><span class="hint">The end-of-day reports saved so far. Tap one to open, change or send it again.</span></div>
      ${S.dailyReports.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Day</th><th class="num">Payments received</th><th class="num">Expenses</th><th class="num">Day closing balance</th><th>Saved by</th></tr></thead><tbody>
        ${S.dailyReports.slice(0, 31).map(r => `<tr class="clickable" data-act="daily-report" data-id="${esc(r.id)}"><td><b>${fmtDate(r.date)}</b></td><td class="num">${money(r.values?.payTotal || 0)}</td><td class="num">${money(num(r.values?.expenses) + num(r.values?.bankPayments))}</td><td class="num">${money(r.values?.closingBalance || 0)}</td><td>${esc(r.savedBy || "")}<span class="sub">${U.fmtWhen(r.savedAt)}</span></td></tr>`).join("")}
      </tbody></table></div>` : empty("No daily reports yet. Tap Daily report at the end of the day.")}
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h2>${esc(y)} month by month</h2><span class="hint">Tap a month for its breakdown and cash book below.</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Month</th><th class="num">Memberships</th><th class="num">Other income</th><th class="num">Total income</th><th class="num">Expenses</th><th class="num">Net</th><th class="num">Joined</th><th class="num">Cancelled</th></tr></thead><tbody>
        ${stats.map(s => `<tr class="clickable" data-act="ui" data-id="repMonth=${s.m}"${s.m === ym ? ' style="outline:2px solid var(--brand);outline-offset:-2px"' : ""}><td><b>${fmtMonth(s.m)}</b></td><td class="num">${money(s.mem)}</td><td class="num">${money(s.other)}</td><td class="num"><b>${money(s.inc)}</b></td><td class="num">${money(s.exp)}</td><td class="num" style="color:${s.net < 0 ? "var(--bad)" : "inherit"}">${money(s.net)}</td><td class="num">${s.joined}</td><td class="num">${s.cancelled}</td></tr>`).join("")}
      </tbody><tfoot><tr><td>Total</td><td class="num">${money(tot("mem"))}</td><td class="num">${money(tot("other"))}</td><td class="num">${money(tot("inc"))}</td><td class="num">${money(tot("exp"))}</td><td class="num">${money(tot("net"))}</td><td class="num">${tot("joined")}</td><td class="num">${tot("cancelled")}</td></tr></tfoot></table></div>
    </div>
    <div class="toolbar"><h2 style="font-size:16px">${fmtMonth(ym)}</h2><input type="month" id="rep-month" value="${ym}" data-ui="repMonth" style="width:auto" aria-label="Month"></div>
    <div class="cols-2" style="margin-bottom:16px">
      ${mini("Income by type", group(mp, p => p.type || "Membership", p => p.amount))}
      ${mini("Income by payment method", group(mp, p => p.method || "Not recorded", p => p.amount))}
      ${mini("Income by program", byProg)}
      ${mini("Expenses by category", group(me, x => x.category, x => x.amount))}
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h2>Cash book: ${fmtMonth(ym)}</h2><span class="hint">Every amount in and out, in date order, like the ACCOUNTS sheet.</span>
        <div class="right"><select id="cash-method" data-ui="cashMethod" style="width:auto" aria-label="Payment method">${options(["Cash", "Petty cash", "Card", "Bank transfer", "Not recorded"], S.ui.cashMethod, { blank: "All methods" })}</select><button class="btn small" data-act="export" data-id="cashbook">Export</button></div></div>
      ${book.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Particulars</th><th>Date</th><th>Method</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th></tr></thead><tbody>
        ${book.map(r => `<tr><td><b>${esc(r.text)}</b><span class="sub">${esc(r.sub || "")}</span></td><td>${fmtDate(r.date)}</td><td>${esc(r.method)}</td><td class="num">${r.inAmt ? money(r.inAmt) : ""}</td><td class="num">${r.outAmt ? money(r.outAmt) : ""}</td><td class="num">${money(r.bal)}</td></tr>`).join("")}
      </tbody><tfoot><tr><td colspan="3">Totals</td><td class="num">${money(sum(book, r => r.inAmt))}</td><td class="num">${money(sum(book, r => r.outAmt))}</td><td class="num">${money(book.length ? book[book.length - 1].bal : 0)}</td></tr></tfoot></table></div>` : empty("Nothing in or out this month.")}
    </div>
    <div class="cols-2">
      <div class="panel"><div class="panel-head"><h2>Cancellations in ${fmtMonth(ym)}</h2></div>
        ${cancels.length ? `<ul class="list">${cancels.map(m => `<li><div class="grow"><button class="linkish" data-act="member" data-id="${esc(m.id)}">${esc(m.name)}</button><span class="sub">${esc(m.cancelReason || "")}${m.cancelNote ? " · " + esc(m.cancelNote) : ""}</span></div><span>${fmtDate(m.cancelDate)}</span></li>`).join("")}</ul>` : empty("No cancellations this month.")}
      </div>
      ${mini("Why members cancel (all time)", reasons, v => v)}
    </div>`;
}

function viewActivity() {
  const q = S.ui.actQ.toLowerCase();
  const rows = S.activity.filter(a => !q || (a.text || "").toLowerCase().includes(q) || (a.by || "").toLowerCase().includes(q));
  return `
    <div class="toolbar"><input type="search" id="act-q" placeholder="Search the log…" value="${esc(S.ui.actQ)}" data-ui="actQ"><span class="spacer"></span><span class="hint">Every change is recorded automatically with who did it and when. Showing the latest ${S.activity.length}.</span></div>
    <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>What happened</th><th>When</th><th>By</th></tr></thead><tbody>
      ${rows.map(a => `<tr><td>${esc(a.text)}</td><td>${U.fmtWhen(a.at)}</td><td>${esc(a.by || "")}</td></tr>`).join("")}
    </tbody></table></div>` : empty("Nothing logged yet.")}</div>`;
}

function rowsEditor(kind, cols, rows, addLabel) {
  return `<div class="panel-body rows-edit" style="--cols:${cols.map(c => c.w || "1fr").join(" ")} auto">
    ${rows.length ? rows.map((r, i) => `<div class="row">${cols.map(c => c.type === "select"
      ? `<select data-draft="${kind}.${i}.${c.key}" aria-label="${esc(c.label)}">${options(c.options, r[c.key])}</select>`
      : `<input${c.type ? ` type="${c.type}"` : ""}${c.type === "number" ? ' min="0" step="any"' : ""} data-draft="${kind}.${i}.${c.key}" value="${esc(r[c.key] ?? "")}" placeholder="${esc(c.label)}" aria-label="${esc(c.label)}">`).join("")}
      <button class="btn small danger" data-act="del-row" data-id="${kind}.${i}" aria-label="Remove">✕</button></div>`).join("") : `<p class="hint">Nothing here yet.</p>`}
    <button class="btn small" data-act="add-row" data-id="${kind}">${addLabel}</button></div>`;
}

function viewSettings() {
  if (!S.ui.draft) S.ui.draft = structuredClone({ ...DEFAULT_SETTINGS, ...S.settings });
  const d = S.ui.draft;
  return `
    <div class="grid" style="max-width:1000px">
      <div class="panel"><div class="panel-head"><h2>Club details</h2></div><div class="panel-body fgrid">
        <div><label for="s-name">Club name</label><input id="s-name" data-draft="clubName" value="${esc(d.clubName)}"></div>
        <div><label for="s-wa">Club WhatsApp number</label><input id="s-wa" data-draft="whatsapp" value="${esc(d.whatsapp)}"></div>
        <div><label for="s-cur">Currency</label><input id="s-cur" data-draft="currency" value="${esc(d.currency)}"></div>
        <div><label for="s-win">Show renewals this many days before the end</label><input id="s-win" type="number" min="0" max="60" data-draft="renewWindow" value="${esc(d.renewWindow)}"></div>
        <div class="full"><label for="s-rem">WhatsApp renewal reminder</label><textarea id="s-rem" data-draft="reminderText">${esc(d.reminderText)}</textarea><span class="hint">Placeholders: {name} {date} {amount} {club}</span></div>
        <div class="full"><label for="s-bal">WhatsApp reminder for money owed</label><textarea id="s-bal" data-draft="balanceText">${esc(d.balanceText)}</textarea><span class="hint">Placeholders: {name} {amount} {what} {club}</span></div>
        <div class="full"><label for="s-can">WhatsApp message to cancelled members</label><textarea id="s-can" data-draft="cancelText">${esc(d.cancelText)}</textarea><span class="hint">Asks if they want to cancel for sure or renew. Placeholders: {name} {date} {amount} {club}</span></div>
      </div></div>

      <div class="panel"><div class="panel-head"><h2>Receipts & accountant</h2><span class="hint">Where "Send to the accountant" on the Receipt photos page goes.</span></div><div class="panel-body fgrid">
        <div><label for="s-accname">Name</label><input id="s-accname" data-draft="accountantName" value="${esc(d.accountantName)}" placeholder="Accountant group"></div>
        <div><label for="s-acclink">WhatsApp group link</label><input id="s-acclink" type="url" data-draft="accountantLink" value="${esc(d.accountantLink)}" placeholder="https://chat.whatsapp.com/…" autocapitalize="none" spellcheck="false"></div>
        <div class="full hint">On a phone, Send opens the share menu with the photos: choose WhatsApp, then the group. On a computer, the photos download and the group opens in WhatsApp so you can drag them in.</div>
      </div></div>

      <div class="panel"><div class="panel-head"><h2>Fee plans</h2><span class="hint">Prices for kids and adults. "Months" sets the end date of a new membership; use 0 for session packs.</span></div>
        ${rowsEditor("plans", [{ key: "name", label: "Plan name", w: "2fr" }, { key: "months", label: "Months", type: "number" }, { key: "kids", label: "Kids price", type: "number" }, { key: "adults", label: "Adults price", type: "number" }], d.plans || [], "+ Add plan")}</div>

      <div class="panel"><div class="panel-head"><h2>Other fees</h2><span class="hint">Registration, uniform… offered when you add a charge.</span></div>
        ${rowsEditor("extraFees", [{ key: "name", label: "Fee name", w: "2fr" }, { key: "kids", label: "Kids price", type: "number" }, { key: "adults", label: "Adults price", type: "number" }], d.extraFees || [], "+ Add fee")}</div>

      <div class="panel"><div class="panel-head"><h2>Monthly bills</h2><span class="hint">Rent, electricity & water, phone, salaries… They appear every month under Expenses so nothing is forgotten.</span></div>
        ${rowsEditor("bills", [{ key: "name", label: "Bill name", w: "2fr" }, { key: "category", label: "Category", type: "select", options: EXP_CATS, w: "1.6fr" }, { key: "amount", label: "Usual amount", type: "number" }, { key: "dueDay", label: "Due day", type: "number" }], d.bills || [], "+ Add bill")}</div>

      <div class="panel"><div class="panel-head"><h2>Class schedule</h2><span class="hint">Times use the 24-hour clock (17:00 = 5 PM).</span></div>
        ${rowsEditor("schedule", [{ key: "day", label: "Day", type: "select", options: DAYS.map(x => x[0]) }, { key: "from", label: "From", type: "time" }, { key: "to", label: "To", type: "time" }, { key: "class", label: "Class", w: "2fr" }, { key: "group", label: "Group", type: "select", options: GROUPS }], d.schedule || [], "+ Add class")}</div>

      <div class="save-bar"><button class="btn primary" data-act="save-settings">Save settings</button> <button class="btn" data-act="reset-draft">Undo changes</button></div>

      <div class="panel"><div class="panel-head"><h2>Import & backup</h2></div><div class="panel-body grid">
        <div><b>Add members from Excel.</b> <span class="hint">In Excel choose File → Save As → CSV UTF-8, then import. Columns are matched by their names (Name, Phone, Program, Start date, End date, Amount…).</span>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="import-members">Import members from CSV</button><button class="btn" data-act="csv-template">Download template</button></div></div>
        <div><b>Backup.</b> <span class="hint">Download everything as one file and keep it somewhere safe, or restore from a backup / import file. The normal backup has small previews of the receipt photos; the bigger one has the full photos too.</span>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="backup">Download full backup</button><button class="btn" data-act="backup" data-id="photos">Backup with receipt photos</button><button class="btn" data-act="restore">Restore / import file</button></div></div>
      </div></div>

      ${MODE === "demo" ? `<div class="panel"><div class="panel-head"><h2>Demo data</h2></div><div class="panel-body" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" data-act="demo-seed">Reload sample data</button><button class="btn danger" data-act="demo-clear">Delete all demo data</button></div></div>`
        : `<div class="panel"><div class="panel-head"><h2>Shared login</h2><span class="hint">All admins use one username and password. Change it when someone leaves, then tell the others the new one.</span></div>
          <div class="panel-body"><form id="pw-form" class="fgrid" novalidate>
            <div class="full"><label for="pw-cur">Current password</label><input id="pw-cur" type="password" autocomplete="current-password"></div>
            <div><label for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password" minlength="8"></div>
            <div><label for="pw-new2">New password again</label><input id="pw-new2" type="password" autocomplete="new-password" minlength="8"></div>
            <div class="full"><button class="btn primary" type="button" data-act="change-password">Change password</button></div>
          </form></div></div>`}
    </div>`;
}

const VIEWS = { dashboard: viewDashboard, members: viewMembers, payments: viewPayments, receipts: viewReceipts, expenses: viewExpenses, schedule: viewSchedule, equipment: viewEquipment, leads: viewLeads, attendance: viewAttendance, reports: viewReports, activity: viewActivity, settings: viewSettings };

// ---------- Forms ----------
function nextReceipt() {
  const n = Math.max(0, ...S.payments.map(p => Number(String(p.receipt || "").replace(/\D/g, "")) || 0));
  return `R-${String(n + 1).padStart(4, "0")}`;
}

// The club's paper vouchers: a Receipt Voucher (سند قبض) for money in, a Payment Voucher (سند صرف) for money out.
// Each form that takes or spends money asks for the voucher number and an optional photo of it (saved under Receipt photos).
const VOUCHER = { in: "Receipt voucher", out: "Payment voucher" };
const receiptFields = (prefix, no = "", kind = "in", name = "bookNo") => `
  <div><label for="${prefix}-book">${VOUCHER[kind]} no.</label><input id="${prefix}-book" name="${name}" maxlength="30" value="${esc(no)}" placeholder="The red number on the voucher" autocomplete="off"></div>
  <div><label for="${prefix}-photo">${VOUCHER[kind]} photo</label><input id="${prefix}-photo" type="file" accept="image/*" multiple data-photo></div>`;
function attachPhotos(form, p, paymentId) {
  const files = form.querySelector("[data-photo]")?.files;
  if (!files?.length) return;
  addReceiptPhotos([...files], { kind: "in", paymentId, memberId: p.memberId, memberName: p.memberName, name: p.memberName || p.payerName, amount: p.amount, date: p.date, number: p.bookNo || "", method: p.method, being: p.type || "" }, { stay: true })
    .catch(err => U.toast(err.message || String(err), "error"));
}
function attachExpensePhotos(form, x, expenseId) {
  const files = form.querySelector("[data-photo]")?.files;
  if (!files?.length) return;
  addReceiptPhotos([...files], { kind: "out", expenseId, name: x.vendor, amount: x.amount, date: x.date, number: x.voucherNo || "", method: x.method, being: x.description }, { stay: true })
    .catch(err => U.toast(err.message || String(err), "error"));
}

function memberOptions(selected, { allowNone = true } = {}) {
  const groups = [["current", "Active"], ["other", "Expired / no membership"], ["paused", "Paused"], ["cancelled", "Cancelled"]];
  const bucket = m => { const st = stateOf(m).state; return isCurrent({ state: st }) ? "current" : st === "paused" ? "paused" : st === "cancelled" ? "cancelled" : "other"; };
  return (allowNone ? `<option value="">— Not a member / walk-in —</option>` : `<option value="">— Choose a member —</option>`) + groups.map(([s, l]) => {
    const ms = S.members.filter(m => bucket(m) === s).sort(byName);
    return ms.length ? `<optgroup label="${l}">${ms.map(m => `<option value="${esc(m.id)}"${m.id === selected ? " selected" : ""}>${esc(m.name)}${m.phone ? " · " + esc(m.phone) : ""}</option>`).join("")}</optgroup>` : "";
  }).join("");
}

// Payment toward a membership/charge balance, or a stand-alone payment.
function openPayment(pre = {}) {
  modal({
    title: "Record payment",
    submitLabel: "Save payment",
    body: `<div class="fgrid">
      <div class="full"><label for="p-member">Member</label><select id="p-member" name="memberId">${memberOptions(pre.memberId)}</select></div>
      <div class="full" id="p-payer-wrap"><label for="p-payer">Paid by (name) *</label><input id="p-payer" name="payerName" maxlength="100"></div>
      <div class="full" id="p-for-wrap"><label for="p-for">For</label><select id="p-for" name="membershipId"></select></div>
      <div id="p-type-wrap"><label for="p-type">Type</label><select id="p-type" name="type">${options(PAY_TYPES, "Membership")}</select></div>
      <div><label for="p-amount">Amount (${esc(S.settings.currency)}) *</label><input id="p-amount" name="amount" type="number" min="0" step="0.01" required inputmode="decimal"></div>
      <div><label for="p-method">Method</label><select id="p-method" name="method">${options(METHODS, "Cash")}</select></div>
      <div><label for="p-date">Date received</label><input id="p-date" name="date" type="date" value="${U.todayISO()}" required></div>
      ${receiptFields("p")}
      <div class="full"><label for="p-note">Note</label><input id="p-note" name="note" maxlength="200" placeholder="Optional"></div>
      <div class="full" id="p-hint"></div>
    </div>`,
    onOpen(el) {
      const f = el.querySelector("form");
      const fillFor = () => {
        const m = memberById(f.memberId.value);
        el.querySelector("#p-payer-wrap").hidden = !!m;
        f.payerName.required = !m;
        el.querySelector("#p-for-wrap").hidden = !m;
        if (!m) { f.membershipId.innerHTML = ""; return; }
        const open = membershipsOf(m.id).filter(ms => balanceOf(ms) > 0);
        const pick = pre.membershipId || open[0]?.id || "";
        f.membershipId.innerHTML = open.map(ms => `<option value="${esc(ms.id)}"${ms.id === pick ? " selected" : ""}>${esc(whatOf(ms))}: owes ${esc(money(balanceOf(ms)))}</option>`).join("") + `<option value=""${pick ? "" : " selected"}>Something else (not linked)</option>`;
      };
      const sync = () => {
        const ms = membershipById(f.membershipId.value);
        el.querySelector("#p-type-wrap").hidden = !!ms;
        if (ms && !pre.amount) f.amount.value = balanceOf(ms);
        const m = memberById(f.memberId.value);
        const o = m ? owedOf(m) : null;
        el.querySelector("#p-hint").innerHTML = m ? `<div class="callout ${o.total ? "warn" : "info"}">${esc(m.name)} ${o.total ? `owes ${money(o.total)} in total.` : "doesn't owe anything. To renew, use Renew instead."}</div>` : "";
      };
      f.memberId.addEventListener("change", () => { pre.membershipId = ""; f.amount.value = ""; fillFor(); sync(); });
      f.membershipId.addEventListener("change", () => { f.amount.value = ""; sync(); });
      fillFor(); sync();
      if (pre.amount) f.amount.value = pre.amount;
    },
    async onSubmit(d, form) {
      const m = memberById(d.memberId);
      if (!(num(d.amount) > 0)) { U.toast("Enter an amount above zero.", "error"); return false; }
      const ms = m ? membershipById(d.membershipId) : null;
      const p = {
        memberId: m ? m.id : "", memberName: m ? m.name : "", payerName: m ? "" : d.payerName,
        membershipId: ms ? ms.id : "", type: ms ? (ms.kind === "charge" ? ms.chargeType || "Uniform & gear sale" : "Membership") : d.type,
        amount: num(d.amount), method: d.method, date: d.date, bookNo: d.bookNo, note: d.note, receipt: nextReceipt(), createdAt: U.nowISO(), createdBy: who()
      };
      const pid = await store.add("payments", p);
      attachPhotos(form, p, pid);
      await log(`Recorded payment ${p.receipt}${p.bookNo ? ` (receipt no. ${p.bookNo})` : ""}: ${money(p.amount)} from ${p.memberName || p.payerName} for ${ms ? whatOf(ms) : p.type} (${p.method})`);
      U.toast(`Saved ${p.receipt}: ${money(p.amount)}`);
    }
  });
}

// New membership or renewal: plan + dates + price, and the payment taken now.
function openMembership(pre = {}) {
  const plans = (S.settings.plans || []).filter(p => num(p.months) > 0);
  const m0 = memberById(pre.memberId);
  const last = m0 ? latestOf(m0.id) : null;
  const today = U.todayISO();
  const start0 = last && last.endDate && last.endDate >= today ? last.endDate : today;
  modal({
    title: last ? `Renew ${m0.name}` : m0 ? `New membership: ${m0.name}` : "New membership",
    submitLabel: "Save membership",
    body: `<div class="fgrid">
      <div class="full"><label for="ms-member">Member *</label><select id="ms-member" name="memberId" required>${memberOptions(pre.memberId, { allowNone: false })}</select></div>
      <div><label for="ms-course">Program</label><select id="ms-course" name="course">${options(PROGRAMS, last?.course || (m0?.programs || [])[0] || "MMA")}</select></div>
      <div><label for="ms-age">Price for</label><select id="ms-age" name="age">${options([["adults", "Adult"], ["kids", "Kid"]], m0?.ageGroup === "Kids" ? "kids" : "adults")}</select></div>
      <div class="full"><label for="ms-plan">Plan</label><select id="ms-plan" name="plan">${options([...plans.map(p => [p.name, `${p.name} (${p.months} month${num(p.months) === 1 ? "" : "s"})`]), ["__custom", "Other / custom"]], last ? (plans.find(p => p.name === last.plan) ? last.plan : "__custom") : plans[0]?.name || "__custom")}</select></div>
      <div class="full" id="ms-custom-wrap"><label for="ms-custom">Plan name</label><input id="ms-custom" name="customPlan" maxlength="80" value="${esc(last && !plans.find(p => p.name === last.plan) ? last.plan : "")}" placeholder="e.g. 1 month + 3 sessions"></div>
      <div><label for="ms-start">Starts</label><input id="ms-start" name="startDate" type="date" value="${start0}" required></div>
      <div><label for="ms-end">Ends</label><input id="ms-end" name="endDate" type="date" required></div>
      <div><label for="ms-pkg">Package price</label><input id="ms-pkg" name="packageAmount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(last?.packageAmount ?? "")}"></div>
      <div><label for="ms-kit">Kit / uniform price</label><input id="ms-kit" name="kitAmount" type="number" min="0" step="0.01" inputmode="decimal" value="0"></div>
      <div class="full" id="ms-kit-items-wrap"><label for="ms-kit-items">Kit items</label><input id="ms-kit-items" name="kitItems" maxlength="120" placeholder="e.g. gloves, shin guards, T-shirt"></div>
      <div><label for="ms-paid">Paid now</label><input id="ms-paid" name="paidNow" type="number" min="0" step="0.01" inputmode="decimal"></div>
      <div><label for="ms-method">Method</label><select id="ms-method" name="method">${options(METHODS, "Cash")}</select></div>
      ${receiptFields("ms")}
      <div class="full"><label style="display:flex;gap:8px;align-items:center;color:var(--text);margin:0"><input type="checkbox" name="handout"> Kit still to be handed out</label></div>
      <div class="full"><label for="ms-note">Note</label><input id="ms-note" name="note" maxlength="200" placeholder="Optional: offer, sessions…"></div>
      <div class="full" id="ms-hint"></div>
    </div>`,
    onOpen(el) {
      const f = el.querySelector("form");
      let endTouched = false, priceTouched = !!last;
      const plan = () => plans.find(p => p.name === f.plan.value);
      const sync = (why) => {
        const p = plan();
        el.querySelector("#ms-custom-wrap").hidden = !!p;
        if (p && !priceTouched && (why === "plan" || why === "age" || why === "init")) f.packageAmount.value = num(p[f.age.value]) || "";
        if (!endTouched && f.startDate.value) f.endDate.value = U.addMonthsISO(f.startDate.value, p ? num(p.months) : 1);
        el.querySelector("#ms-kit-items-wrap").hidden = !(num(f.kitAmount.value) > 0);
        const total = num(f.packageAmount.value) + num(f.kitAmount.value);
        if (!f.paidNow.dataset.touched) f.paidNow.value = total || "";
        const owe = round(total - num(f.paidNow.value));
        el.querySelector("#ms-hint").innerHTML = total ? `<div class="callout ${owe > 0 ? "warn" : "ok"}">Total ${money(total)}${owe > 0 ? `, ${money(owe)} still to pay (it will show under Money owed)` : ", fully paid"}.</div>` : "";
      };
      f.memberId.addEventListener("change", () => {
        const m = memberById(f.memberId.value);
        const l = m ? latestOf(m.id) : null;
        if (m) { f.age.value = m.ageGroup === "Kids" ? "kids" : "adults"; if (l?.course) f.course.value = l.course; f.startDate.value = l && l.endDate && l.endDate >= today ? l.endDate : today; }
        priceTouched = false; sync("plan");
      });
      f.plan.addEventListener("change", () => { priceTouched = false; sync("plan"); });
      f.age.addEventListener("change", () => { priceTouched = false; sync("age"); });
      f.startDate.addEventListener("change", () => sync("start"));
      f.endDate.addEventListener("change", () => { endTouched = true; });
      f.packageAmount.addEventListener("input", () => { priceTouched = true; sync("price"); });
      f.kitAmount.addEventListener("input", () => sync("price"));
      f.paidNow.addEventListener("input", () => { f.paidNow.dataset.touched = "1"; sync("paid"); });
      sync("init");
    },
    async onSubmit(d, form) {
      const m = memberById(d.memberId);
      if (!m) { U.toast("Choose the member.", "error"); return false; }
      if (d.endDate < d.startDate) { U.toast("The end date is before the start date.", "error"); return false; }
      const planName = d.plan === "__custom" ? (d.customPlan || "Custom") : d.plan;
      const ms = { memberId: m.id, memberName: m.name, kind: "membership", course: d.course, plan: planName, packageAmount: num(d.packageAmount), kitAmount: num(d.kitAmount), kitItems: d.kitItems, startDate: d.startDate, endDate: d.endDate, paidBeforeImport: 0, note: d.note, createdAt: U.nowISO(), createdBy: who() };
      const msId = await store.add("memberships", ms);
      const paid = num(d.paidNow);
      if (paid > 0) {
        const p = { memberId: m.id, memberName: m.name, payerName: "", membershipId: msId, type: "Membership", amount: paid, method: d.method, date: U.todayISO(), bookNo: d.bookNo, note: "", receipt: nextReceipt(), createdAt: U.nowISO(), createdBy: who() };
        attachPhotos(form, p, await store.add("payments", p));
      }
      if (d.handout && d.kitItems) await store.add("handouts", { name: m.name, memberId: m.id, item: d.kitItems, done: false, createdAt: U.nowISO(), createdBy: who() });
      const patch = {};
      if (m.status !== "active") Object.assign(patch, { status: "active", pausedFrom: "", pauseUntil: "", pauseReason: "", cancelDate: "", cancelReason: "", cancelNote: "" });
      if (!m.joinDate || d.startDate < m.joinDate) patch.joinDate = d.startDate;
      if (d.course && !(m.programs || []).includes(d.course)) patch.programs = [...(m.programs || []), d.course];
      if (Object.keys(patch).length) await store.update("members", m.id, patch);
      const total = ms.packageAmount + ms.kitAmount;
      await log(`${last && last.memberId === m.id ? "Renewed" : "New membership for"} ${m.name}: ${planName}, ${fmtDate(d.startDate)} → ${fmtDate(d.endDate)}, ${money(total)}${paid ? `, paid ${money(paid)} (${d.method})` : ", not paid yet"}${m.status === "cancelled" ? " (re-joined)" : ""}`);
      U.toast(paid >= total ? "Membership saved and paid" : paid ? `Saved. ${money(round(total - paid))} still to pay` : "Membership saved");
    }
  });
}

// One-off charge: kit sale, registration fee, personal training… paid now or owed.
function openCharge(pre = {}) {
  const fees = S.settings.extraFees || [];
  const eq = pre.equipmentId ? S.equipment.find(e => e.id === pre.equipmentId) : null;
  modal({
    title: eq ? `Sell ${eq.name}` : "Kit or other charge",
    submitLabel: "Save",
    body: `<div class="fgrid">
      <div class="full"><label for="c-member">Member *</label><select id="c-member" name="memberId" required>${memberOptions(pre.memberId, { allowNone: false })}</select></div>
      <div><label for="c-type">Type</label><select id="c-type" name="chargeType">${options(CHARGE_TYPES, eq ? "Uniform & gear sale" : "Uniform & gear sale")}</select></div>
      ${fees.length && !eq ? `<div><label for="c-fee">Quick pick</label><select id="c-fee">${options(fees.map((f, i) => [String(i), f.name]), "", { blank: "—" })}</select></div>` : "<div></div>"}
      <div class="full"><label for="c-desc">What for *</label><input id="c-desc" name="description" required maxlength="120" value="${esc(eq ? eq.name : pre.description || "")}" placeholder="e.g. Gloves 10 oz, mouth guard"></div>
      <div><label for="c-amount">Price *</label><input id="c-amount" name="amount" type="number" min="0" step="0.01" required inputmode="decimal" value="${esc(eq?.salePrice || pre.amount || "")}"></div>
      <div><label for="c-paid">Paid now</label><input id="c-paid" name="paidNow" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(eq?.salePrice || pre.amount || "")}"></div>
      <div><label for="c-method">Method</label><select id="c-method" name="method">${options(METHODS, "Cash")}</select></div>
      <div><label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-top:24px"><input type="checkbox" name="handout"> Still to hand out</label></div>
      ${receiptFields("c")}
    </div>`,
    onOpen(el) {
      const f = el.querySelector("form");
      const pick = el.querySelector("#c-fee");
      if (pick) pick.addEventListener("change", () => {
        const fee = fees[Number(pick.value)];
        if (!fee) return;
        const m = memberById(f.memberId.value);
        const price = num(m?.ageGroup === "Kids" ? fee.kids : fee.adults) || num(fee.adults) || num(fee.kids);
        f.description.value = fee.name;
        f.amount.value = price || "";
        f.paidNow.value = price || "";
        if (/regist/i.test(fee.name)) f.chargeType.value = "Registration fee";
      });
      f.amount.addEventListener("input", () => { f.paidNow.value = f.amount.value; });
    },
    async onSubmit(d, form) {
      const m = memberById(d.memberId);
      if (!m) { U.toast("Choose the member.", "error"); return false; }
      const amount = num(d.amount);
      if (!(amount > 0)) { U.toast("Enter the price.", "error"); return false; }
      const id = await store.add("memberships", { memberId: m.id, memberName: m.name, kind: "charge", chargeType: d.chargeType, description: d.description, amount, startDate: U.todayISO(), paidBeforeImport: 0, createdAt: U.nowISO(), createdBy: who() });
      const paid = num(d.paidNow);
      if (paid > 0) {
        const p = { memberId: m.id, memberName: m.name, payerName: "", membershipId: id, type: d.chargeType, amount: paid, method: d.method, date: U.todayISO(), bookNo: d.bookNo, note: d.description, receipt: nextReceipt(), createdAt: U.nowISO(), createdBy: who() };
        attachPhotos(form, p, await store.add("payments", p));
      }
      if (d.handout) await store.add("handouts", { name: m.name, memberId: m.id, item: d.description, done: false, createdAt: U.nowISO(), createdBy: who() });
      if (eq) {
        await store.update("equipment", eq.id, { qty: Math.max(0, num(eq.qty) - 1) });
      }
      await log(`${eq ? "Sold" : "Charged"} ${m.name}: ${d.description} ${money(amount)}${paid ? `, paid ${money(paid)} (${d.method})` : ", not paid yet"}${eq ? ` (stock now ${Math.max(0, num(eq.qty) - 1)})` : ""}`);
      U.toast(paid >= amount ? "Saved and paid" : `Saved. ${money(round(amount - paid))} still to pay`);
    }
  });
}

function memberForm(m = {}) {
  const progs = new Set(m.programs || []);
  const status = m.status === "cancelled" ? `
    <div class="full"><h4 class="section-title" style="margin-top:4px">Cancellation</h4></div>
    <div><label for="mf-cdate">Cancelled on</label><input id="mf-cdate" name="cancelDate" type="date" value="${esc(m.cancelDate)}"></div>
    <div><label for="mf-creason">Reason</label><select id="mf-creason" name="cancelReason">${options([...new Set([...CANCEL_REASONS, m.cancelReason || ""])].filter(Boolean), m.cancelReason, { blank: "—" })}</select></div>
    <div class="full"><label for="mf-cnote">Cancellation note</label><input id="mf-cnote" name="cancelNote" maxlength="300" value="${esc(m.cancelNote)}"></div>`
    : m.status === "paused" ? `
    <div class="full"><h4 class="section-title" style="margin-top:4px">Pause</h4></div>
    <div><label for="mf-pfrom">Paused from</label><input id="mf-pfrom" name="pausedFrom" type="date" value="${esc(m.pausedFrom)}"></div>
    <div><label for="mf-puntil">Until</label><input id="mf-puntil" name="pauseUntil" type="date" value="${esc(m.pauseUntil)}"></div>
    <div class="full"><label for="mf-preason">Reason</label><input id="mf-preason" name="pauseReason" maxlength="200" value="${esc(m.pauseReason)}"></div>` : "";
  return `<div class="fgrid">
    <div><label for="mf-name">Full name *</label><input id="mf-name" name="name" required maxlength="100" value="${esc(m.name)}"></div>
    <div><label for="mf-phone">Phone / WhatsApp</label><input id="mf-phone" name="phone" type="tel" maxlength="30" value="${esc(m.phone)}" placeholder="05X XXX XXXX"></div>
    <div><label for="mf-age">Kid or adult</label><select id="mf-age" name="ageGroup">${options(["Adults", "Kids"], m.ageGroup || "Adults")}</select></div>
    <div><label for="mf-join">Joining date</label><input id="mf-join" name="joinDate" type="date" value="${esc(m.id ? m.joinDate : m.joinDate || U.todayISO())}"></div>
    <div><label for="mf-dob">Date of birth</label><input id="mf-dob" name="dob" type="date" value="${esc(m.dob)}"></div>
    <div><label for="mf-gname">Parent / guardian</label><input id="mf-gname" name="guardianName" maxlength="100" value="${esc(m.guardianName)}"></div>
    <div><label for="mf-gphone">Guardian phone</label><input id="mf-gphone" name="guardianPhone" type="tel" maxlength="30" value="${esc(m.guardianPhone)}"></div>
    <div class="full"><label>Programs</label><div class="checks">${PROGRAMS.map(p => `<label><input type="checkbox" name="programs" data-multi value="${esc(p)}"${progs.has(p) ? " checked" : ""}>${esc(p)}</label>`).join("")}</div></div>
    <div><label for="mf-email">Email</label><input id="mf-email" name="email" type="email" maxlength="120" value="${esc(m.email)}"></div>
    <div><label for="mf-belt">Belt / rank</label><input id="mf-belt" name="belt" maxlength="60" value="${esc(m.belt)}" placeholder="e.g. Yellow belt"></div>
    <div class="full"><label for="mf-em">Emergency contact</label><input id="mf-em" name="emergency" maxlength="120" value="${esc(m.emergency)}" placeholder="Name and phone"></div>
    <div class="full"><label for="mf-notes">Notes (medical, injuries, anything useful)</label><textarea id="mf-notes" name="notes" maxlength="2000">${esc(m.notes)}</textarea></div>
    ${status}
  </div>`;
}
// Fields the form shows; the cancellation / pause ones only when the member is cancelled / paused.
function memberData(d) {
  const out = { name: d.name, phone: d.phone, email: d.email, dob: d.dob, joinDate: d.joinDate, ageGroup: d.ageGroup, guardianName: d.guardianName, guardianPhone: d.guardianPhone, programs: d.programs || [], belt: d.belt, emergency: d.emergency, notes: d.notes };
  for (const k of ["cancelDate", "cancelReason", "cancelNote", "pausedFrom", "pauseUntil", "pauseReason"]) if (k in d) out[k] = d[k];
  return out;
}
const FIELD_NAMES = { name: "name", phone: "phone", email: "email", dob: "date of birth", joinDate: "joining date", ageGroup: "kid/adult", guardianName: "guardian", guardianPhone: "guardian phone", programs: "programs", belt: "belt", emergency: "emergency contact", notes: "notes", cancelDate: "cancel date", cancelReason: "cancel reason", cancelNote: "cancel note", pausedFrom: "pause start", pauseUntil: "pause end", pauseReason: "pause reason" };

// Names are copied onto memberships, payments, check-ins, kit and receipts (so lists stay fast); a rename updates them all.
function renameOps(memberId, name) {
  return [
    ...S.memberships.filter(x => x.memberId === memberId && x.memberName !== name).map(x => ["memberships", x.id, { memberName: name }]),
    ...S.payments.filter(x => x.memberId === memberId && x.memberName !== name).map(x => ["payments", x.id, { memberName: name }]),
    ...S.attendance.filter(x => x.memberId === memberId && x.memberName !== name).map(x => ["attendance", x.id, { memberName: name }]),
    ...S.handouts.filter(x => x.memberId === memberId && x.name !== name).map(x => ["handouts", x.id, { name }]),
    ...S.receipts.filter(x => x.memberId === memberId && x.memberName !== name).map(x => ["receipts", x.id, { memberName: name }])
  ];
}

function openNewMember(pre = {}) {
  modal({
    title: "Add member", wide: true,
    body: memberForm(pre),
    footer: `<footer><label class="left" style="display:flex;gap:6px;align-items:center;margin:0;color:var(--text)"><input type="checkbox" name="startNow" checked> Start a membership next</label><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add member</button></footer>`,
    async onSubmit(d) {
      const data = { ...memberData(d), status: "active", createdAt: U.nowISO(), createdBy: who() };
      if (!data.phone && !data.guardianPhone) U.toast("Saved without a phone number. Add one later so you can send WhatsApp reminders.");
      const id = await store.add("members", data);
      await log(`Added member ${data.name} (${(data.programs || []).join(", ") || "no program yet"})`);
      U.toast(`${data.name} added`);
      if (pre.leadId) {
        await store.update("leads", pre.leadId, { status: "Joined", memberId: id });
        await log(`Trial request from ${data.name} → Joined`);
      }
      if (d.startNow) setTimeout(() => openMembership({ memberId: id }), 150);
    }
  });
}

function openEditMember(id) {
  const m = memberById(id);
  if (!m) return;
  modal({
    title: `Edit ${m.name}`, wide: true,
    body: memberForm(m),
    async onSubmit(d) {
      const data = memberData(d);
      const changes = Object.keys(data).filter(k => JSON.stringify(data[k] ?? "") !== JSON.stringify(m[k] ?? ""));
      await store.update("members", id, data);
      const moved = data.name !== m.name ? await store.updateMany(renameOps(id, data.name)) : 0;
      if (changes.length) await log(`Edited member ${data.name}${data.name !== m.name ? ` (was ${m.name})` : ""}: ${changes.map(k => FIELD_NAMES[k] || k).join(", ")}${moved ? ` · name updated on ${moved} linked records` : ""}`);
      U.toast(changes.length ? "Saved" : "Nothing changed");
    }
  });
}

function memberDetail(id) {
  modal({
    title: "Member", wide: true,
    live: () => {
      const m = memberById(id);
      if (!m) return null;
      const st = stateOf(m);
      const o = owedOf(m);
      const mss = membershipsOf(id);
      const pays = paymentsOf(id);
      const visits = S.attendance.filter(a => a.memberId === id);
      const v30 = visits.filter(a => a.date >= U.addDays(U.todayISO(), -30)).length;
      const lastV = visits.map(a => a.date).sort().pop();
      const age = U.ageFrom(m.dob);
      const wa = U.waLink(m.phone);
      const gwa = U.waLink(m.guardianPhone);
      const hand = S.handouts.filter(h => h.memberId === id && !h.done);
      const photos = receiptsByPayment();
      return `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px"><h3 style="font-size:20px">${esc(m.name)}</h3>${stateBadge(st)}<button type="button" class="btn small" style="margin-left:auto" data-act="edit-member" data-id="${esc(id)}">Edit details</button></div>
        ${o.total ? `<div class="callout bad">Owes <b>${money(o.total)}</b>: ${o.list.map(x => `${esc(x.ms.kind === "charge" ? x.ms.description : x.ms.plan || "membership")} ${money(x.bal)}`).join(", ")}.</div>` : ""}
        ${st.state === "expired" ? `<div class="callout warn">Membership ended ${fmtDate(st.ms.endDate)} (${st.days} days ago).</div>` : ""}
        ${m.status === "cancelled" ? `<div class="callout info">Cancelled on ${fmtDate(m.cancelDate)}${m.cancelReason ? ` · ${esc(m.cancelReason)}` : ""}${m.cancelNote ? ` · ${esc(m.cancelNote)}` : ""}
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">${askState(m)}${m.cancelAskedAt ? `<span class="hint">asked ${U.fmtWhen(m.cancelAskedAt)}${m.cancelAskedBy ? ` by ${esc(m.cancelAskedBy)}` : ""}</span>` : ""}</div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${remindLink(m, "cancel", m.cancelAskedAt ? "Ask again on WhatsApp" : "Ask on WhatsApp: cancel or renew?") || `<span class="hint">No phone number, so no WhatsApp message. Tap Edit to add one.</span>`}
            <button type="button" class="btn small" data-act="cancel-answer" data-id="${esc(id)}" data-answer="renew">Wants to renew</button>
            <button type="button" class="btn small" data-act="cancel-answer" data-id="${esc(id)}" data-answer="cancel">Confirmed cancel</button>
            <button type="button" class="btn small" data-act="cancel-answer" data-id="${esc(id)}" data-answer="none">No reply</button></div></div>` : ""}
        ${m.status === "paused" ? `<div class="callout warn">Paused since ${fmtDate(m.pausedFrom)}${m.pauseUntil ? ` until ${fmtDate(m.pauseUntil)}` : ""}${m.pauseReason ? ` · ${esc(m.pauseReason)}` : ""}.</div>` : ""}
        ${hand.length ? `<div class="callout info">Kit to hand out: ${hand.map(h => `${esc(h.item)} <button type="button" class="linkish" data-act="handout-done" data-id="${esc(h.id)}">mark handed out</button>`).join(" · ")}</div>` : ""}
        <div class="dl">
          <div><b>Phone</b>${esc(m.phone || "—")}${wa ? ` · <a href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}</div>
          ${m.guardianName || m.guardianPhone ? `<div><b>Guardian</b>${esc(m.guardianName || "")} ${esc(m.guardianPhone || "")}${gwa ? ` · <a href="${esc(gwa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}</div>` : ""}
          <div><b>Programs</b>${esc((m.programs || []).join(", ") || "—")}</div>
          <div><b>Membership</b>${st.ms ? `${esc(st.ms.plan || "")}<br><span class="hint">${fmtDate(st.ms.startDate)} – ${fmtDate(st.ms.endDate)}</span>` : "—"}</div>
          <div><b>Joined</b>${fmtDate(m.joinDate)}</div>
          ${m.dob ? `<div><b>Date of birth</b>${fmtDate(m.dob)}</div>` : ""}
          ${m.ageGroup ? `<div><b>Group</b>${esc(m.ageGroup)}${age !== "" ? ` · ${age} yrs` : ""}</div>` : ""}
          ${m.email ? `<div><b>Email</b><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></div>` : ""}
          ${m.belt ? `<div><b>Belt / rank</b>${esc(m.belt)}</div>` : ""}
          <div><b>Visits (30 days)</b>${v30}${lastV ? `<br><span class="hint">last ${fmtDate(lastV)}</span>` : ""}</div>
          ${m.emergency ? `<div><b>Emergency</b>${esc(m.emergency)}</div>` : ""}
          ${m.lastReminderAt ? `<div><b>Last reminder</b>${U.fmtWhen(m.lastReminderAt)}</div>` : ""}
        </div>
        ${m.notes ? `<div class="callout info" style="white-space:pre-wrap">${esc(m.notes)}</div>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${m.status !== "cancelled" ? `<button type="button" class="btn primary" data-act="renew" data-id="${esc(id)}">${st.ms ? "Renew" : "Start membership"}</button>` : `<button type="button" class="btn primary" data-act="renew" data-id="${esc(id)}">Re-join</button>`}
          ${o.total ? `<button type="button" class="btn" data-act="pay-member" data-id="${esc(id)}">Record payment</button>${remindLink(m, "balance", "Remind to pay")}` : ""}
          ${["expired", "ending"].includes(st.state) ? remindLink(m, "renewal", "Renewal reminder") : ""}
          <button type="button" class="btn" data-act="new-charge" data-id="${esc(id)}">+ Kit / charge</button>
          ${m.status !== "cancelled" ? `<button type="button" class="btn" data-act="checkin-one" data-id="${esc(id)}">Check in</button>` : ""}
          ${m.status === "active" || !m.status ? `<button type="button" class="btn" data-act="pause-member" data-id="${esc(id)}">Pause</button>` : ""}
          ${m.status === "paused" ? `<button type="button" class="btn" data-act="resume-member" data-id="${esc(id)}">Resume</button>` : ""}
          ${m.status !== "cancelled" ? `<button type="button" class="btn danger" data-act="cancel-member" data-id="${esc(id)}">Cancel membership</button>` : ""}
        </div>
        <h4 class="section-title">Memberships & charges</h4>
        ${mss.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>What</th><th>Dates</th><th class="num">Price</th><th class="num">Paid</th><th class="num">Balance</th><th></th></tr></thead><tbody>
          ${mss.map(ms => { const bal = balanceOf(ms); return `<tr><td><b>${esc(ms.kind === "charge" ? ms.description : ms.plan || "Membership")}</b><span class="sub">${esc(ms.kind === "charge" ? ms.chargeType || "Charge" : [ms.course, ms.kitItems ? "kit: " + ms.kitItems : ms.kitAmount ? "incl. kit " + money(ms.kitAmount) : ""].filter(Boolean).join(" · "))}${ms.note ? " · " + esc(ms.note) : ""}</span></td>
            <td>${ms.kind === "charge" ? fmtDate(ms.startDate) : `${fmtDate(ms.startDate)} – ${fmtDate(ms.endDate)}`}</td><td class="num">${money(totalOf(ms))}</td><td class="num">${money(paidOf(ms))}</td>
            <td class="num">${bal ? `<b style="color:var(--bad)">${money(bal)}</b>` : "—"}</td>
            <td class="actions">${bal ? `<button type="button" class="btn small primary" data-act="pay-ms" data-id="${esc(ms.id)}">Pay</button>` : ""}<button type="button" class="btn small" data-act="edit-ms" data-id="${esc(ms.id)}">Edit</button></td></tr>`; }).join("")}
          </tbody></table></div>` : `<p class="hint">No memberships yet.</p>`}
        <h4 class="section-title">Payments</h4>
        ${pays.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Amount</th><th>Date</th><th>Type</th><th>Method</th><th></th></tr></thead><tbody>
          ${pays.map(p => { const ph = photos.get(p.id); return `<tr><td><b>${money(p.amount)}</b>${payNo(p) ? `<span class="sub">${esc(payNo(p))}</span>` : ""}</td><td>${fmtDate(p.date)}</td><td>${esc(p.type || "Membership")}</td><td>${esc(p.method || "")}</td><td class="actions">${ph ? `<button type="button" class="btn small" data-act="rc-open" data-id="${esc(ph.id)}">Photo</button>` : ""}<button type="button" class="btn small" data-act="receipt" data-id="${esc(p.id)}">Receipt</button><button type="button" class="btn small" data-act="edit-payment" data-id="${esc(p.id)}">Edit</button></td></tr>`; }).join("")}
          </tbody><tfoot><tr><td colspan="4">Total paid: ${money(sum(pays, p => p.amount))}</td><td></td></tr></tfoot></table></div>` : `<p class="hint">No payments linked to this member.</p>`}
        <footer><button type="button" class="btn left" data-act="merge-member" data-id="${esc(id)}">Merge with another member…</button><button type="button" class="btn danger" data-act="del-member" data-id="${esc(id)}">Delete</button><button type="button" class="btn" data-close>Close</button></footer>`;
    }
  });
}

function openEditMembership(id) {
  const ms = membershipById(id);
  if (!ms) return;
  const charge = ms.kind === "charge";
  const planNames = [...new Set([...(S.settings.plans || []).map(p => p.name), ...S.memberships.filter(x => x.kind !== "charge").map(x => x.plan)].filter(Boolean))].sort();
  const linked = S.payments.filter(p => p.membershipId === id);
  modal({
    title: charge ? "Edit charge" : "Edit membership",
    body: `<div class="fgrid">
      <div class="full"><label for="em-member">Member</label><select id="em-member" name="memberId" required>${memberOptions(ms.memberId, { allowNone: false })}</select>${linked.length ? `<span class="hint">If you change the member, ${linked.length === 1 ? "its payment moves" : `its ${linked.length} payments move`} too.</span>` : ""}</div>
      ${charge ? `<div><label for="em-type">Type</label><select id="em-type" name="chargeType">${options([...new Set([...CHARGE_TYPES, ms.chargeType || ""])].filter(Boolean), ms.chargeType || "Uniform & gear sale")}</select></div>
        <div><label for="em-date">Date</label><input id="em-date" name="startDate" type="date" value="${esc(ms.startDate)}"></div>
        <div class="full"><label for="em-desc">What for</label><input id="em-desc" name="description" value="${esc(ms.description)}" maxlength="120"></div>
        <div><label for="em-amount">Price</label><input id="em-amount" name="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(ms.amount)}"></div>`
      : `<div><label for="em-plan">Plan</label><input id="em-plan" name="plan" value="${esc(ms.plan)}" maxlength="80" list="em-plans"><datalist id="em-plans">${planNames.map(n => `<option value="${esc(n)}">`).join("")}</datalist></div>
        <div><label for="em-course">Program</label><select id="em-course" name="course">${options([...new Set([...PROGRAMS, ms.course || ""])].filter(Boolean), ms.course)}</select></div>
        <div><label for="em-start">Starts</label><input id="em-start" name="startDate" type="date" value="${esc(ms.startDate)}"></div>
        <div><label for="em-end">Ends</label><input id="em-end" name="endDate" type="date" value="${esc(ms.endDate)}"></div>
        <div><label for="em-pkg">Package price</label><input id="em-pkg" name="packageAmount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(ms.packageAmount)}"></div>
        <div><label for="em-kit">Kit / uniform price</label><input id="em-kit" name="kitAmount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(ms.kitAmount)}"></div>
        <div class="full"><label for="em-kititems">Kit items</label><input id="em-kititems" name="kitItems" maxlength="120" value="${esc(ms.kitItems)}" placeholder="e.g. gloves, shin guards, T-shirt"></div>`}
      <div><label for="em-before">Paid before this system</label><input id="em-before" name="paidBeforeImport" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(ms.paidBeforeImport || 0)}"><span class="hint">From the Excel sheets. Payments recorded here are added on top${linked.length ? ` (${money(sum(linked, p => p.amount))} so far)` : ""}.</span></div>
      <div class="full"><label for="em-note">Note</label><input id="em-note" name="note" value="${esc(ms.note)}" maxlength="200"></div>
    </div>`,
    footer: `<footer><button type="button" class="btn danger left" data-act="del-ms" data-id="${esc(id)}">Delete</button><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></footer>`,
    async onSubmit(d) {
      const m = memberById(d.memberId);
      if (!m) { U.toast("Choose the member.", "error"); return false; }
      if (!charge && d.startDate && d.endDate && d.endDate < d.startDate) { U.toast("The end date is before the start date.", "error"); return false; }
      const patch = charge
        ? { chargeType: d.chargeType, startDate: d.startDate, description: d.description, amount: num(d.amount) }
        : { plan: d.plan, course: d.course, startDate: d.startDate, endDate: d.endDate, packageAmount: num(d.packageAmount), kitAmount: num(d.kitAmount), kitItems: d.kitItems };
      Object.assign(patch, { memberId: m.id, memberName: m.name, paidBeforeImport: num(d.paidBeforeImport), note: d.note });
      await store.update("memberships", id, patch);
      const moved = m.id !== ms.memberId ? await store.updateMany(linked.map(p => ["payments", p.id, { memberId: m.id, memberName: m.name }])) : 0;
      await log(`Edited ${charge ? "charge" : "membership"} of ${m.name}${m.id !== ms.memberId ? ` (moved from ${ms.memberName}${moved ? ` with ${moved} payments` : ""})` : ""}: ${charge ? `${d.description} ${money(d.amount)}` : `${d.plan}, ${fmtDate(d.startDate)} → ${fmtDate(d.endDate)}, ${money(num(d.packageAmount) + num(d.kitAmount))}`}`);
      U.toast("Saved");
    }
  });
}

function openEditPayment(id) {
  const p = S.payments.find(x => x.id === id);
  if (!p) return;
  modal({
    title: `Edit payment${p.receipt ? " " + p.receipt : ""}`,
    body: `<div class="fgrid">
      <div class="full"><label for="ep-member">Member</label><select id="ep-member" name="memberId">${memberOptions(p.memberId)}</select></div>
      <div class="full" id="ep-payer-wrap"><label for="ep-payer">Paid by (name) *</label><input id="ep-payer" name="payerName" maxlength="100" value="${esc(p.payerName)}"></div>
      <div class="full" id="ep-for-wrap"><label for="ep-for">For</label><select id="ep-for" name="membershipId"></select></div>
      <div><label for="ep-type">Type</label><select id="ep-type" name="type">${options([...new Set([...PAY_TYPES, p.type || ""])].filter(Boolean), p.type || "Membership")}</select></div>
      <div><label for="ep-amount">Amount (${esc(S.settings.currency)}) *</label><input id="ep-amount" name="amount" type="number" min="0" step="0.01" required inputmode="decimal" value="${esc(p.amount)}"></div>
      <div><label for="ep-method">Method</label><select id="ep-method" name="method">${options([...new Set([...METHODS, p.method || ""])].filter(Boolean), p.method || "Cash")}</select></div>
      <div><label for="ep-date">Date received</label><input id="ep-date" name="date" type="date" value="${esc(p.date)}" required></div>
      <div><label for="ep-book">Receipt no.</label><input id="ep-book" name="bookNo" maxlength="30" value="${esc(p.bookNo)}" placeholder="From the receipt book" autocomplete="off"></div>
      <div><label for="ep-photo">Add receipt photo</label><input id="ep-photo" type="file" accept="image/*" multiple data-photo></div>
      <div class="full"><label for="ep-note">Note</label><input id="ep-note" name="note" maxlength="200" value="${esc(p.note)}"></div>
      <div class="full hint">Recorded ${U.fmtWhen(p.createdAt)}${p.createdBy ? ` by ${esc(p.createdBy)}` : ""}.</div>
    </div>`,
    footer: `<footer><button type="button" class="btn danger left" data-act="del-payment" data-id="${esc(id)}">Delete</button><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></footer>`,
    onOpen(el) {
      const f = el.querySelector("form");
      const fillFor = keep => {
        const m = memberById(f.memberId.value);
        el.querySelector("#ep-payer-wrap").hidden = !!m;
        f.payerName.required = !m;
        el.querySelector("#ep-for-wrap").hidden = !m;
        const list = m ? membershipsOf(m.id) : [];
        const pick = keep ? p.membershipId : "";
        f.membershipId.innerHTML = list.map(ms => `<option value="${esc(ms.id)}"${ms.id === pick ? " selected" : ""}>${esc(whatOf(ms))}${balanceOf(ms) ? `: owes ${esc(money(balanceOf(ms)))}` : ""}</option>`).join("") + `<option value=""${list.some(ms => ms.id === pick) ? "" : " selected"}>Something else (not linked)</option>`;
      };
      f.memberId.addEventListener("change", () => fillFor(false));
      fillFor(true);
    },
    async onSubmit(d, form) {
      const m = memberById(d.memberId);
      if (!(num(d.amount) > 0)) { U.toast("Enter an amount above zero.", "error"); return false; }
      const ms = m ? membershipById(d.membershipId) : null;
      const patch = {
        memberId: m ? m.id : "", memberName: m ? m.name : "", payerName: m ? "" : d.payerName, membershipId: ms ? ms.id : "",
        type: d.type, amount: num(d.amount), method: d.method, date: d.date, bookNo: d.bookNo, note: d.note
      };
      const changed = Object.keys(patch).filter(k => String(patch[k] ?? "") !== String(p[k] ?? ""));
      if (changed.length) await store.update("payments", id, patch);
      attachPhotos(form, { ...p, ...patch }, id);
      const was = `${money(p.amount)} from ${p.memberName || p.payerName} on ${fmtDate(p.date)}`;
      if (changed.length) await log(`Edited payment ${p.receipt || ""} (${was}): now ${money(patch.amount)} from ${patch.memberName || patch.payerName} on ${fmtDate(patch.date)}, ${patch.method}${patch.bookNo ? `, receipt no. ${patch.bookNo}` : ""}`);
      U.toast(changed.length ? "Payment saved" : "Nothing changed");
    }
  });
}

function openMerge(id) {
  const m = memberById(id);
  modal({
    title: `Merge ${m.name} into…`,
    submitLabel: "Merge",
    body: `<p class="hint" style="margin-top:0">Use this when the same person was entered twice (e.g. different spellings). Everything from <b>${esc(m.name)}</b> (memberships, payments, check-ins, kit to hand out) moves to the member you choose, then ${esc(m.name)} is removed.</p>
      <label for="mg-target">Keep this member</label><select id="mg-target" name="target" required>${memberOptions("", { allowNone: false }).replace(`<option value="${esc(m.id)}">`, `<option value="${esc(m.id)}" disabled>`)}</select>`,
    async onSubmit(d) {
      const t = memberById(d.target);
      if (!t || t.id === m.id) { U.toast("Choose a different member to keep.", "error"); return false; }
      const moves = [
        ...S.memberships.filter(x => x.memberId === m.id).map(x => ["memberships", x.id]),
        ...S.payments.filter(x => x.memberId === m.id).map(x => ["payments", x.id]),
        ...S.attendance.filter(x => x.memberId === m.id).map(x => ["attendance", x.id]),
        ...S.handouts.filter(x => x.memberId === m.id).map(x => ["handouts", x.id])
      ];
      for (const [col, docId] of moves) await store.update(col, docId, col === "handouts" ? { memberId: t.id, name: t.name } : { memberId: t.id, memberName: t.name });
      const patch = { programs: [...new Set([...(t.programs || []), ...(m.programs || [])])] };
      for (const k of ["phone", "guardianName", "guardianPhone", "email", "dob", "belt", "emergency"]) if (!t[k] && m[k]) patch[k] = m[k];
      if (m.notes) patch.notes = [t.notes, m.notes].filter(Boolean).join("\n");
      if (m.joinDate && (!t.joinDate || m.joinDate < t.joinDate)) patch.joinDate = m.joinDate;
      await store.update("members", t.id, patch);
      await store.remove("members", m.id);
      await log(`Merged member ${m.name} into ${t.name} (${moves.length} records moved)`);
      document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
      U.toast(`Merged into ${t.name}`);
      setTimeout(() => memberDetail(t.id), 100);
    }
  });
}

function openCancel(id) {
  const m = memberById(id);
  modal({
    title: `Cancel ${m.name}'s membership`, submitLabel: "Cancel membership",
    body: `<div class="fgrid">
      <div><label for="c-date">Cancelled on</label><input id="c-date" name="cancelDate" type="date" value="${U.todayISO()}" required></div>
      <div><label for="c-reason">Reason</label><select id="c-reason" name="cancelReason">${options(CANCEL_REASONS, "")}</select></div>
      <div class="full"><label for="c-note">Note</label><input id="c-note" name="cancelNote" maxlength="300" placeholder="Optional: refund, coming back in summer…"></div>
      <div class="full hint">They stop showing in renewals and money owed. Their history stays, and you can re-join them any time.</div></div>`,
    async onSubmit(d) {
      await store.update("members", id, { status: "cancelled", cancelDate: d.cancelDate, cancelReason: d.cancelReason, cancelNote: d.cancelNote });
      await log(`Cancelled membership: ${m.name} on ${fmtDate(d.cancelDate)} (${d.cancelReason}${d.cancelNote ? " – " + d.cancelNote : ""})`);
      U.toast(`${m.name} cancelled`);
    }
  });
}

function openPause(id) {
  const m = memberById(id);
  modal({
    title: `Pause ${m.name}`, submitLabel: "Pause membership",
    body: `<div class="fgrid">
      <div><label for="pa-from">Paused from</label><input id="pa-from" name="pausedFrom" type="date" value="${U.todayISO()}" required></div>
      <div><label for="pa-until">Until (optional)</label><input id="pa-until" name="pauseUntil" type="date"></div>
      <div class="full"><label for="pa-reason">Reason</label><input id="pa-reason" name="pauseReason" maxlength="200" placeholder="Vacation, injury, exams…"></div>
      <div class="full hint">The price list allows freezing for up to one month at no extra cost. When you resume, you can extend the end date from their membership's Edit button.</div></div>`,
    async onSubmit(d) {
      await store.update("members", id, { status: "paused", pausedFrom: d.pausedFrom, pauseUntil: d.pauseUntil, pauseReason: d.pauseReason });
      await log(`Paused membership: ${m.name} from ${fmtDate(d.pausedFrom)}${d.pauseUntil ? " until " + fmtDate(d.pauseUntil) : ""}${d.pauseReason ? " (" + d.pauseReason + ")" : ""}`);
      U.toast(`${m.name} paused`);
    }
  });
}

function openExpense(pre = {}) {
  const x = pre.id ? S.expenses.find(e => e.id === pre.id) : null;
  const v = x || pre;
  modal({
    title: x ? "Expense" : pre.billId ? `Enter bill: ${pre.description}` : "Add expense",
    submitLabel: x ? "Save changes" : "Save expense",
    body: `<div class="fgrid">
      <div class="full"><label for="e-desc">Description *</label><input id="e-desc" name="description" required maxlength="200" value="${esc(v.description || "")}" placeholder="e.g. Fuel, Sajar advance, FEWA bill"></div>
      <div><label for="e-cat">Category</label><select id="e-cat" name="category">${options(EXP_CATS, v.category || "Other")}</select></div>
      <div><label for="e-amount">Amount (${esc(S.settings.currency)}) *</label><input id="e-amount" name="amount" type="number" min="0" step="0.01" required inputmode="decimal" value="${esc(v.amount || "")}"></div>
      <div><label for="e-status">Status</label><select id="e-status" name="status">${options([["paid", "Paid"], ["unpaid", "Not paid yet"]], v.status || "paid")}</select></div>
      <div class="e-paid"><label for="e-method">Paid with</label><select id="e-method" name="method">${options(EXP_METHODS, v.method || "Cash")}</select></div>
      <div class="e-paid"><label for="e-date">Date paid</label><input id="e-date" name="date" type="date" value="${esc(v.date || U.todayISO())}"></div>
      <div class="e-unpaid"><label for="e-due">Due date</label><input id="e-due" name="dueDate" type="date" value="${esc(v.dueDate || "")}"></div>
      <div><label for="e-vendor">Paid to</label><input id="e-vendor" name="vendor" maxlength="120" value="${esc(v.vendor || "")}" placeholder="Staff name, shop, FEWA…"></div>
      <div><label for="e-ref">Invoice / reference no.</label><input id="e-ref" name="ref" maxlength="80" value="${esc(v.ref || "")}"></div>
      ${receiptFields("e", v.voucherNo || "", "out", "voucherNo")}
      <div class="full"><label for="e-notes">Notes</label><input id="e-notes" name="notes" maxlength="300" value="${esc(v.notes || "")}"></div>
      ${x ? `<div class="full hint">Added ${U.fmtWhen(x.createdAt)} by ${esc(x.createdBy || "")}</div>` : ""}</div>`,
    onOpen(el) {
      const f = el.querySelector("form");
      const sync = () => {
        const unpaid = f.status.value === "unpaid";
        el.querySelectorAll(".e-paid").forEach(n => { n.hidden = unpaid; });
        el.querySelectorAll(".e-unpaid").forEach(n => { n.hidden = !unpaid; });
      };
      f.status.addEventListener("change", sync);
      sync();
    },
    async onSubmit(d, form) {
      const unpaid = d.status === "unpaid";
      const data = {
        category: d.category, amount: num(d.amount), description: d.description, vendor: d.vendor, ref: d.ref, voucherNo: d.voucherNo,
        status: d.status, method: unpaid ? "" : d.method, date: unpaid ? (d.dueDate || U.todayISO()) : d.date || U.todayISO(),
        dueDate: unpaid ? d.dueDate : (x?.dueDate || ""), notes: d.notes
      };
      if (x) {
        await store.update("expenses", x.id, data);
        attachExpensePhotos(form, data, x.id);
        await log(`Edited expense: ${data.description} ${money(data.amount)} (${unpaid ? "unpaid" : "paid"})${data.voucherNo ? `, payment voucher no. ${data.voucherNo}` : ""}`);
      } else {
        Object.assign(data, { billId: pre.billId || "", period: pre.period || "", createdAt: U.nowISO(), createdBy: who() });
        attachExpensePhotos(form, data, await store.add("expenses", data));
        await log(`${pre.billId ? "Entered bill" : "Added expense"}: ${data.description} ${money(data.amount)} – ${data.category} (${unpaid ? "not paid yet" : "paid by " + data.method})${data.voucherNo ? `, payment voucher no. ${data.voucherNo}` : ""}`);
      }
      U.toast("Saved");
    }
  });
}

function openPayExpense(id) {
  const x = S.expenses.find(e => e.id === id);
  modal({
    title: `Pay: ${x.description || x.category}`, submitLabel: "Mark as paid",
    body: `<div class="fgrid">
      <div><label for="pe-amount">Amount paid</label><input id="pe-amount" name="amount" type="number" min="0" step="0.01" required value="${esc(x.amount)}"></div>
      <div><label for="pe-method">Paid with</label><select id="pe-method" name="method">${options(EXP_METHODS, "Bank transfer")}</select></div>
      <div><label for="pe-date">Date paid</label><input id="pe-date" name="date" type="date" value="${U.todayISO()}" required></div>
      <div><label for="pe-ref">Reference</label><input id="pe-ref" name="ref" maxlength="80" value="${esc(x.ref || "")}"></div></div>`,
    async onSubmit(d) {
      await store.update("expenses", id, { status: "paid", amount: num(d.amount), method: d.method, date: d.date, ref: d.ref, dueDate: x.dueDate || "" });
      await log(`Paid bill: ${x.description || x.category} ${money(d.amount)} (${d.method})`);
      U.toast("Marked as paid");
    }
  });
}

function openEquipment(id) {
  const e = id ? S.equipment.find(x => x.id === id) : {};
  modal({
    title: id ? `Edit ${e.name}` : "Add item", submitLabel: id ? "Save" : "Add",
    body: `<div class="fgrid">
      <div class="full"><label for="q-name">Item *</label><input id="q-name" name="name" required maxlength="120" value="${esc(e.name || "")}" placeholder="e.g. Gloves 10 oz"></div>
      <div class="full"><label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="forSale"${e.forSale ? " checked" : ""}> Stock we sell to members (gloves, mouth guards…)</label></div>
      <div><label for="q-cat">Category</label><select id="q-cat" name="category">${options(EQ_CATS, e.category || "Other")}</select></div>
      <div><label for="q-qty">Quantity</label><input id="q-qty" name="qty" type="number" min="0" step="1" value="${esc(e.qty ?? 1)}"></div>
      <div><label for="q-price">Selling price</label><input id="q-price" name="salePrice" type="number" min="0" step="0.01" value="${esc(e.salePrice ?? "")}"></div>
      <div><label for="q-cost">Cost per item (${esc(S.settings.currency)})</label><input id="q-cost" name="unitCost" type="number" min="0" step="0.01" value="${esc(e.unitCost || "")}"></div>
      <div><label for="q-cond">Condition</label><select id="q-cond" name="condition">${options(EQ_COND, e.condition || "New")}</select></div>
      <div><label for="q-date">Purchase date</label><input id="q-date" name="purchaseDate" type="date" value="${esc(e.purchaseDate || "")}"></div>
      <div><label for="q-sup">Supplier</label><input id="q-sup" name="supplier" maxlength="120" value="${esc(e.supplier || "")}"></div>
      <div><label for="q-loc">Location</label><input id="q-loc" name="location" maxlength="80" value="${esc(e.location || "")}" placeholder="Main hall, storage…"></div>
      <div><label for="q-svc">Next service / check</label><input id="q-svc" name="serviceDue" type="date" value="${esc(e.serviceDue || "")}"></div>
      <div class="full"><label for="q-notes">Notes</label><input id="q-notes" name="notes" maxlength="300" value="${esc(e.notes || "")}"></div>
      ${id ? "" : `<div class="full"><label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="asExpense" checked> Also log the purchase as a paid expense</label></div>
      <div><label for="q-method">Paid with</label><select id="q-method" name="method">${options(EXP_METHODS, "Cash")}</select></div>`}</div>`,
    footer: `<footer>${id ? `<button type="button" class="btn danger left" data-act="del-eq" data-id="${esc(id)}">Delete</button>` : ""}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${id ? "Save" : "Add"}</button></footer>`,
    async onSubmit(d) {
      const data = { name: d.name, forSale: !!d.forSale, category: d.category, qty: num(d.qty), salePrice: num(d.salePrice), condition: d.condition, unitCost: num(d.unitCost), purchaseDate: d.purchaseDate, supplier: d.supplier, location: d.location, serviceDue: d.serviceDue, notes: d.notes };
      if (id) {
        await store.update("equipment", id, data);
        await log(`Edited ${data.forSale ? "stock" : "equipment"}: ${data.name}${e.qty !== data.qty ? ` (qty ${e.qty} → ${data.qty})` : ""}${e.condition !== data.condition ? ` (${e.condition} → ${data.condition})` : ""}`);
      } else {
        await store.add("equipment", { ...data, createdAt: U.nowISO(), createdBy: who() });
        await log(`Added ${data.forSale ? "stock" : "equipment"}: ${data.qty}× ${data.name}`);
        const total = data.qty * data.unitCost;
        if (d.asExpense && total > 0) {
          await store.add("expenses", { category: "Equipment purchase", amount: total, description: `${data.qty}× ${data.name}`, vendor: data.supplier, status: "paid", method: d.method, date: data.purchaseDate || U.todayISO(), createdAt: U.nowISO(), createdBy: who() });
          await log(`Added expense: ${data.qty}× ${data.name} ${money(total)} – Equipment purchase`);
        }
      }
      U.toast("Saved");
    }
  });
}

function openRestock(id) {
  const e = S.equipment.find(x => x.id === id);
  modal({
    title: `Add stock: ${e.name}`, submitLabel: "Add to stock",
    body: `<div class="fgrid">
      <div><label for="rs-qty">How many arrived</label><input id="rs-qty" name="qty" type="number" min="1" step="1" required value="1" autofocus></div>
      <div><label for="rs-cost">Total paid (optional)</label><input id="rs-cost" name="cost" type="number" min="0" step="0.01" inputmode="decimal"></div>
      <div><label for="rs-method">Paid with</label><select id="rs-method" name="method">${options(EXP_METHODS, "Cash")}</select></div>
      <div><label for="rs-sup">Supplier</label><input id="rs-sup" name="supplier" maxlength="120" value="${esc(e.supplier || "")}"></div></div>`,
    async onSubmit(d) {
      const qty = num(d.qty);
      await store.update("equipment", id, { qty: num(e.qty) + qty, supplier: d.supplier || e.supplier || "" });
      if (num(d.cost) > 0) await store.add("expenses", { category: "Equipment purchase", amount: num(d.cost), description: `${qty}× ${e.name} (stock)`, vendor: d.supplier, status: "paid", method: d.method, date: U.todayISO(), createdAt: U.nowISO(), createdBy: who() });
      await log(`Stock in: ${qty}× ${e.name} (now ${num(e.qty) + qty})${num(d.cost) ? `, cost ${money(d.cost)}` : ""}`);
      U.toast(`${e.name}: ${num(e.qty) + qty} in stock`);
    }
  });
}

function openLead(id, pre = {}) {
  const l = id ? S.leads.find(x => x.id === id) : pre;
  modal({
    title: id ? `Trial request: ${l.name}` : "Add trial request", submitLabel: id ? "Save" : "Add",
    body: `<div class="fgrid">
      <div><label for="ld-name">Name *</label><input id="ld-name" name="name" required maxlength="100" value="${esc(l.name || "")}"></div>
      <div><label for="ld-phone">Phone *</label><input id="ld-phone" name="phone" type="tel" required maxlength="30" value="${esc(l.phone || "")}"></div>
      <div><label for="ld-prog">Program</label><select id="ld-prog" name="program">${options(["Not sure yet", ...PROGRAMS], l.program || "Not sure yet")}</select></div>
      <div><label for="ld-age">Who</label><select id="ld-age" name="ageGroup">${options(AGE_GROUPS, l.ageGroup || AGE_GROUPS[0])}</select></div>
      <div><label for="ld-time">Best time</label><select id="ld-time" name="preferredTime">${options(TIMES, l.preferredTime || "Evening")}</select></div>
      <div><label for="ld-src">Source</label><select id="ld-src" name="source">${options(LEAD_SOURCES, l.source || "Walk-in")}</select></div>
      <div><label for="ld-status">Status</label><select id="ld-status" name="status">${options(LEAD_STATUS, l.status || "New")}</select></div>
      <div><label for="ld-trial">Trial date</label><input id="ld-trial" name="trialDate" type="date" value="${esc(l.trialDate || "")}"></div>
      <div class="full"><label for="ld-msg">Message / notes</label><textarea id="ld-msg" name="message" maxlength="1000">${esc(l.message || "")}</textarea></div></div>`,
    footer: `<footer>${id ? `<button type="button" class="btn danger left" data-act="del-lead" data-id="${esc(id)}">Delete</button>` : ""}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${id ? "Save" : "Add"}</button></footer>`,
    async onSubmit(d) {
      if (id) {
        await store.update("leads", id, d);
        if (d.status !== l.status) await log(`Trial request from ${d.name}: ${l.status || "New"} → ${d.status}`);
      } else {
        await store.add("leads", { ...d, createdAt: U.nowISO(), createdBy: who() });
        await log(`Added trial request: ${d.name} (${d.program}, ${d.source})`);
      }
      U.toast("Saved");
    }
  });
}

async function checkIn(memberId) {
  const m = memberById(memberId);
  if (!m) return;
  const today = U.todayISO();
  if (S.attendance.some(a => a.memberId === memberId && a.date === today)) { U.toast(`${m.name} is already checked in today`); return; }
  await store.add("attendance", { memberId, memberName: m.name, program: latestOf(m.id)?.course || (m.programs || [])[0] || "", date: today, time: U.nowTime(), by: who() });
  await log(`Checked in ${m.name}`);
  const st = stateOf(m), o = owedOf(m);
  const warn = st.state === "expired" ? `membership expired ${fmtDate(st.ms.endDate)}` : o.total ? `owes ${money(o.total)}` : "";
  U.toast(warn ? `${m.name} checked in. Note: ${warn}` : `${m.name} checked in`, warn ? "error" : "");
}

function openCheckin() {
  let q = "";
  const listHtml = () => {
    const today = U.todayISO();
    const inToday = new Map(S.attendance.filter(a => a.date === today).map(a => [a.memberId, a.time]));
    const ms = S.members.filter(m => m.status !== "cancelled")
      .map(m => ({ m, st: stateOf(m), o: owedOf(m) }))
      .filter(r => q ? (r.m.name || "").toLowerCase().includes(q) || (r.m.phone || "").includes(q) : isCurrent(r.st))
      .sort((a, b) => byName(a.m, b.m)).slice(0, 60);
    return ms.length ? `<ul class="list">${ms.map(({ m, st, o }) => `<li><div class="grow"><b>${esc(m.name)}</b><span class="sub">${esc((m.programs || []).join(", "))}${st.state === "expired" ? ` · <span style="color:var(--bad)">expired ${fmtDate(st.ms.endDate)}</span>` : ""}${o.total ? ` · <span style="color:var(--bad)">owes ${money(o.total)}</span>` : ""}</span></div>
        ${inToday.has(m.id) ? badge("b-ok", "✓ " + inToday.get(m.id)) : `<button type="button" class="btn small primary" data-ci="${esc(m.id)}">Check in</button>`}</li>`).join("")}</ul>` : `<p class="hint">${q ? "Nobody matches." : "No active members."}</p>`;
  };
  modal({
    title: "Check members in",
    body: `<input type="search" id="ci-q" placeholder="Type a name or phone…" autocomplete="off" autofocus><p class="hint" style="margin:6px 0 0">Shows active members; type to find anyone else.</p><div id="ci-list" style="margin-top:10px;max-height:55vh;overflow:auto">${listHtml()}</div>`,
    footer: `<footer><button type="button" class="btn" data-close>Done</button></footer>`,
    onOpen(el) {
      const list = el.querySelector("#ci-list");
      el.querySelector("#ci-q").addEventListener("input", e => { q = e.target.value.trim().toLowerCase(); list.innerHTML = listHtml(); });
      list.addEventListener("click", async e => {
        const b = e.target.closest("[data-ci]");
        if (!b) return;
        b.disabled = true;
        await checkIn(b.dataset.ci);
        setTimeout(() => { list.innerHTML = listHtml(); }, 60);
      });
    }
  });
}

function openReceipt(id) {
  const p = S.payments.find(x => x.id === id);
  if (!p) return;
  const m = memberById(p.memberId);
  const ms = p.membershipId ? membershipById(p.membershipId) : null;
  const forText = ms ? whatOf(ms) : `${p.type}${p.note && !/^from /.test(p.note) ? " – " + p.note : ""}`;
  const text = `${S.settings.clubName}: Receipt voucher${p.bookNo ? ` no. ${p.bookNo}` : p.receipt ? ` ${p.receipt}` : ""}\nReceived from: ${p.memberName || p.payerName}\nThe sum of: ${money(p.amount)}\nBeing: ${forText}\nCash / cheque: ${p.method}\nDate: ${fmtDate(p.date)}\nThank you!`;
  const wa = m ? U.waLink(m.phone || m.guardianPhone, text) : "";
  modal({
    title: p.bookNo ? `Receipt voucher no. ${p.bookNo}` : p.receipt ? `Receipt ${p.receipt}` : "Payment",
    body: `<div class="receipt">
      <div class="r-head"><div><img src="images/logo.png" alt="${esc(S.settings.clubName)}"><div class="hint" style="margin-top:6px">Emirates City, Ajman, UAE, Lavender Tower, P6-610<br>+971 56 261 3563 · +971 6 529 1092<br>www.wariorsmartialarts.com</div></div>
        <div style="text-align:right"><b style="font-size:18px">RECEIPT VOUCHER</b><br><span dir="rtl">سند قبض</span><br>${p.bookNo ? `No. <b style="color:#c0362c">${esc(p.bookNo)}</b>` : esc(p.receipt || "")}<br>Date: ${fmtDate(p.date)}</div></div>
      <table><tr><td>Received from Mr./M/s</td><td>${esc(p.memberName || p.payerName)}</td></tr>
        <tr><td>Being</td><td>${esc(forText)}</td></tr>
        <tr><td>Cash / cheque</td><td>${esc(p.method)}</td></tr>
        <tr class="total"><td>The sum of Dhs</td><td>${money(p.amount)}</td></tr></table>
      <p class="hint" style="margin-top:14px">Recorded by ${esc(p.createdBy || "")}. Thank you for training with us!</p></div>`,
    footer: `<footer>${wa ? `<a class="btn wa left" href="${esc(wa)}" target="_blank" rel="noopener">Send on WhatsApp</a>` : ""}<button type="button" class="btn" data-close>Close</button><button type="button" class="btn primary" data-act="print">Print</button></footer>`
  });
}

// ---------- Daily report ----------
// The club's end-of-day WhatsApp report. Numbers fill in from the system for the chosen day; anything can be typed over,
// and typed values are kept when the report is saved (one report per day, dailyReports/{YYYY-MM-DD}).
const DAILY = [
  { keys: [["enqCall", "Enquiry via call"], ["enqWalk", "Enquiry walk in"], ["callBack", "Call back"]] },
  { title: "Trial session", dash: true, keys: [["trMMA", "MMA"], ["trKick", "Kick boxing"], ["trBoxing", "Boxing"], ["trKalari", "Kalari"], ["trYoga", "Yoga"], ["trBJJ", "BJJ"], ["trOther", "Other", "skip0"]] },
  { title: "Client", keys: [["clActive", "Active"], ["clInactive", "Inactive"], ["clCancelled", "Cancelled"], ["clFrozen", "Membership frozen"]] },
  { title: "New admission", bullet: true, keys: [["newKids", "Kids"], ["newAdults", "Adults"]] },
  { title: "Equipment required", text: true, keys: [["eqGloves", "Gloves"], ["eqMouth", "Mouth guard"], ["eqAp", "AP guard"], ["eqWraps", "Hand wraps"], ["eqShin", "Shin guards"], ["eqKalari", "Kalari"], ["eqTshirt", "T-shirts"], ["eqYoga", "Yoga"], ["eqBjj", "BJJ"]] },
  { title: "Payment and receipts", bullet: true, money: true, keys: [["payTotal", "Payments received"], ["payBank", "Bank"], ["payCard", "Card"], ["payCash", "Cash"], ["closingReceipt", "Closing receipt no", "text"], ["bankPayments", "Bank payments"], ["expenses", "Expenses"], ["cashBalance", "Cash balance"], ["voucherNos", "Payment voucher no", "text"], ["closingBalance", "Day closing balance"]] }
];
const DAILY_KEYS = DAILY.flatMap(s => s.keys.map(k => k[0]));
// Which equipment line a "kit to hand out" item counts towards.
const KIT_WORDS = [["eqGloves", /glove/i], ["eqMouth", /mouth/i], ["eqAp", /\bap\b|abdo|groin/i], ["eqWraps", /wrap/i], ["eqShin", /shin/i], ["eqKalari", /kalari/i], ["eqTshirt", /t-?shirt|tee\b/i], ["eqYoga", /yoga|mat\b/i], ["eqBjj", /bjj|\bgi\b/i]];
const TRIAL_PROGS = [["trMMA", /mma/i], ["trKick", /kick/i], ["trBoxing", /^boxing/i], ["trKalari", /kalari/i], ["trYoga", /yoga/i], ["trBJJ", /bjj|jiu/i]];
const BANK_METHODS = ["Bank transfer", "Cheque"], CARD_METHODS = ["Card", "Payment link"];
// A stored date or timestamp as a local YYYY-MM-DD.
const dayOf = iso => !iso ? "" : iso.length <= 10 ? iso : U.todayISO(new Date(iso));
// All of a day's voucher numbers, lowest first, each once: "1290, 1291, 1292".
const numList = list => [...new Set(list.map(v => String(v ?? "").trim()).filter(Boolean))]
  .sort((a, b) => (Number(a.replace(/\D/g, "")) || 0) - (Number(b.replace(/\D/g, "")) || 0) || a.localeCompare(b)).join(", ");

// A member's situation on a given day (cancelled / frozen / active / inactive), or null if they hadn't joined yet.
function clientOn(m, day) {
  if ((m.joinDate || "") > day) return null;
  if (m.status === "cancelled" && (!m.cancelDate || m.cancelDate <= day)) return "cancelled";
  if (m.status === "paused" && (!m.pausedFrom || m.pausedFrom <= day) && (!m.pauseUntil || m.pauseUntil >= day)) return "frozen";
  const booked = membershipsOf(m.id).some(ms => ms.kind !== "charge" && (!ms.endDate || ms.endDate >= day) && ((ms.startDate || "") <= day || dayOf(ms.createdAt) <= day));
  return booked ? "active" : "inactive";
}

function dailyAuto(day) {
  const v = {};
  const enq = S.leads.filter(l => dayOf(l.createdAt) === day);
  v.enqWalk = enq.filter(l => l.source === "Walk-in").length;
  v.enqCall = enq.length - v.enqWalk;
  v.callBack = enq.filter(l => ["New", "Call back"].includes(l.status || "New")).length;
  const trials = S.leads.filter(l => l.trialDate === day);
  for (const [k, re] of TRIAL_PROGS) v[k] = trials.filter(l => re.test(l.program || "")).length;
  v.trOther = trials.length - sum(TRIAL_PROGS, ([k]) => v[k]);
  const states = S.members.map(m => clientOn(m, day));
  v.clActive = states.filter(s => s === "active").length;
  v.clInactive = states.filter(s => s === "inactive").length;
  v.clCancelled = states.filter(s => s === "cancelled").length;
  v.clFrozen = states.filter(s => s === "frozen").length;
  const joined = S.members.filter(m => m.joinDate === day);
  v.newKids = joined.filter(m => m.ageGroup === "Kids").length;
  v.newAdults = joined.length - v.newKids;
  // Kit still owed to members on that day.
  const owed = S.handouts.filter(h => dayOf(h.createdAt) <= day && (!h.done || dayOf(h.doneAt) > day));
  for (const [k, re] of KIT_WORDS) { const n = owed.filter(h => re.test(h.item || "")).length; v[k] = n ? String(n) : ""; }
  const ps = S.payments.filter(p => p.date === day);
  v.payBank = round(sum(ps.filter(p => BANK_METHODS.includes(p.method)), p => p.amount));
  v.payCard = round(sum(ps.filter(p => CARD_METHODS.includes(p.method)), p => p.amount));
  v.payCash = round(sum(ps, p => p.amount) - v.payBank - v.payCard);
  // Every receipt voucher of the day: memberships, admissions, kit… plus receipt photos dated that day.
  v.closingReceipt = numList([...ps.map(p => p.bookNo), ...S.receipts.filter(r => (r.kind || "in") === "in" && r.date === day).map(r => r.number)]);
  const xs = S.expenses.filter(x => x.status !== "unpaid" && x.date === day);
  v.bankPayments = round(sum(xs.filter(x => [...BANK_METHODS, "Card"].includes(x.method)), x => x.amount));
  v.expenses = round(sum(xs, x => x.amount) - v.bankPayments);
  v.voucherNos = numList([...xs.map(x => x.voucherNo), ...S.receipts.filter(r => r.kind === "out" && r.date === day).map(r => r.number)]);
  // Opening cash = the closing balance of the last saved report before this day.
  const prev = S.dailyReports.filter(r => r.date < day).sort((a, b) => b.date.localeCompare(a.date))[0];
  v.openingBalance = prev && prev.values?.closingBalance !== "" && prev.values?.closingBalance != null ? num(prev.values.closingBalance) : "";
  v.openingFrom = prev ? prev.date : "";
  return v;
}

function dailyText(day, v) {
  const show = (val, s, kind) => {
    if (val === "" || val == null) return s.text || kind === "text" ? "-" : s.money ? money(0) : "0";
    return s.money && kind !== "text" ? money(val) : String(val);
  };
  const lines = [`*Daily report - Wariors*`, `Date: ${fmtDate(day)} (${new Date(day + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long" })})`];
  for (const s of DAILY) {
    lines.push("");
    if (s.title) lines.push(`*${s.title}*`);
    for (const [k, label, kind] of s.keys) {
      if (kind === "skip0" && !num(v[k])) continue;
      lines.push(`${s.bullet ? "* " : ""}${label}${s.dash ? " - " : ": "}${show(v[k], s, kind)}`);
    }
  }
  lines.push("", `Remarks: ${v.remarks || "-"}`);
  return lines.join("\n");
}

function openDailyReport(day0) {
  const field = (k, label, s, kind) => {
    const text = s.text || kind === "text";
    return `<div${kind === "text" ? ' class="dr-wide"' : ""}><label for="dr-${k}">${esc(label)}${kind === "text" ? ` <span class="hint">(all of the day's numbers)</span>` : ""}</label><input id="dr-${k}" name="${k}"${text ? ` maxlength="${kind === "text" ? 400 : 40}" autocomplete="off"` : ' type="number" step="any" inputmode="decimal"'}></div>`;
  };
  let saveReport = null;
  const h = modal({
    title: "Daily report", wide: true,
    body: `<div class="dr-grid">
      <div>
        <div class="dr-date"><div><label for="dr-date">Report for</label><input id="dr-date" name="date" type="date" value="${esc(day0 || U.todayISO())}" required></div>
          <button type="button" class="btn small" id="dr-reset">Use system numbers</button></div>
        <p class="hint" id="dr-status"></p>
        ${DAILY.map(s => `<fieldset class="dr-sec"><legend>${esc(s.title || "Enquiries")}</legend><div class="dr-fields">
          ${s.keys.map(([k, label, kind]) => field(k, label, s, kind)).join("")}
          ${s.money ? `<div><label for="dr-openingBalance">Opening cash (yesterday's closing)</label><input id="dr-openingBalance" name="openingBalance" type="number" step="any" inputmode="decimal"></div>` : ""}
        </div>${s.money ? `<p class="hint">Bank = bank transfers and cheques. Card includes payment links. Bank payments = expenses paid by bank, card or cheque; Expenses = paid in cash or petty cash. Cash balance = cash received − expenses. Day closing balance = opening cash + cash balance.</p>` : s.text ? `<p class="hint">Filled from kit still to hand out. Type how many are needed (or a size, e.g. "2 × 12 oz").</p>` : ""}</fieldset>`).join("")}
        <fieldset class="dr-sec"><legend>Remarks</legend><textarea id="dr-remarks" name="remarks" maxlength="600" placeholder="e.g. Need equipment ASAP"></textarea></fieldset>
      </div>
      <div class="dr-preview"><label for="dr-text">The report</label><textarea id="dr-text" readonly></textarea></div>
    </div>`,
    footer: `<footer><button type="button" class="btn left" id="dr-copy">Copy</button><button type="button" class="btn wa" id="dr-wa">Send on WhatsApp</button><button class="btn primary" type="submit">Save</button></footer>`,
    onOpen(el) {
      const f = el.querySelector("form");
      const preview = el.querySelector("#dr-text");
      let edited = new Set();
      const values = () => { const o = {}; for (const k of [...DAILY_KEYS, "openingBalance", "remarks"]) o[k] = f[k].value.trim() === "" ? "" : f[k].type === "number" ? num(f[k].value) : f[k].value.trim(); return o; };
      const derive = () => {
        const n = k => num(f[k].value);
        if (!edited.has("payTotal")) f.payTotal.value = round(n("payBank") + n("payCard") + n("payCash"));
        if (!edited.has("cashBalance")) f.cashBalance.value = round(n("payCash") - n("expenses"));
        if (!edited.has("closingBalance")) f.closingBalance.value = round(n("openingBalance") + n("cashBalance"));
        preview.value = dailyText(f.date.value, values());
      };
      const load = keepTyped => {
        const day = f.date.value || U.todayISO();
        const saved = S.dailyReports.find(r => r.id === day);
        const auto = dailyAuto(day);
        if (!keepTyped) edited = new Set(saved?.edited || []);
        for (const k of [...DAILY_KEYS, "openingBalance"]) f[k].value = edited.has(k) ? saved?.values?.[k] ?? "" : auto[k] ?? "";
        if (!keepTyped) f.remarks.value = saved?.values?.remarks ?? "";
        el.querySelector("#dr-status").innerHTML = `${saved ? `Saved ${U.fmtWhen(saved.savedAt)}${saved.savedBy ? ` by ${esc(saved.savedBy)}` : ""}. Numbers you typed are kept; the rest update from the system.` : "Not saved yet."}${auto.openingFrom ? ` Opening cash is the closing balance of ${fmtDate(auto.openingFrom)}.` : " No earlier report saved, so type the opening cash once."}`;
        derive();
      };
      f.addEventListener("input", e => { const k = e.target.name; if (k && k !== "date") { edited.add(k); derive(); } });
      f.date.addEventListener("change", () => load(false));
      el.querySelector("#dr-reset").addEventListener("click", () => {
        // Keep what can only be typed (equipment, opening cash, remarks); everything else back to the system's numbers.
        edited = new Set([...edited].filter(k => k.startsWith("eq") || k === "openingBalance"));
        load(true);
        U.toast("Numbers refreshed from the system");
      });
      const save = async quiet => {
        const day = f.date.value;
        const v = values();
        await store.set("dailyReports", day, { date: day, values: v, edited: [...edited], text: dailyText(day, v), savedAt: U.nowISO(), savedBy: who() });
        await log(`Saved the daily report for ${fmtDate(day)}: payments ${money(v.payTotal || 0)}, closing balance ${money(v.closingBalance || 0)}`);
        if (!quiet) U.toast("Daily report saved");
      };
      saveReport = save;
      el.querySelector("#dr-copy").addEventListener("click", () => {
        derive();
        (navigator.clipboard ? navigator.clipboard.writeText(preview.value) : Promise.reject())
          .then(() => U.toast("Report copied. Paste it in WhatsApp."), () => { preview.select(); U.toast("Select all and copy the report text.", "error"); });
        save(true).catch(err => U.toast(err.message || String(err), "error"));
      });
      el.querySelector("#dr-wa").addEventListener("click", () => {
        derive();
        window.open(`https://wa.me/?text=${encodeURIComponent(preview.value)}`, "_blank", "noopener");
        save(true).catch(err => U.toast(err.message || String(err), "error"));
      });
      load(false);
    },
    async onSubmit() {
      if (!h.el.querySelector("form").date.value) { U.toast("Choose the date.", "error"); return false; }
      await saveReport(false);
      return false; // keep it open so it can still be sent
    }
  });
}

// ---------- Receipt photos ----------
// There's no file storage on the free Firebase plan, so photos are shrunk in the browser and saved in the database:
// receipts/{id} holds the details plus a small preview, receiptImages/{id} the full photo (a document holds up to 1 MB).
const PHOTO_SIDE = 1400, PHOTO_CHARS = 520000, THUMB_SIDE = 360, THUMB_CHARS = 45000;

function drawJpeg(img, side, maxChars) {
  let scale = Math.min(1, side / Math.max(img.width, img.height));
  for (let i = 0; i < 6; i++, scale *= 0.8) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.68, 0.56, 0.45]) {
      const url = c.toDataURL("image/jpeg", q);
      if (url.length <= maxChars) return { url, w: c.width, h: c.height };
    }
  }
  throw new Error("too big");
}
async function shrinkPhoto(file) {
  const src = URL.createObjectURL(file);
  try {
    let img;
    try { img = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { img = new Image(); img.src = src; await img.decode(); }
    const full = drawJpeg(img, PHOTO_SIDE, PHOTO_CHARS);
    const thumb = drawJpeg(img, THUMB_SIDE, THUMB_CHARS);
    img.close?.();
    return { full, thumb };
  } catch {
    throw new Error(`Couldn't read ${file.name || "a photo"}.${/hei[cf]/i.test(file.type + file.name) ? " iPhone HEIC photos: choose them from this page on the phone, or save them as JPEG first." : " Use a JPG or PNG photo."}`);
  } finally {
    URL.revokeObjectURL(src);
  }
}
const isPhoto = f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|hei[cf])$/i.test(f.name || "");

// Saves photos as receipts. pre: details to fill in (from a payment). opts.stay: don't jump to the Receipt photos page.
async function addReceiptPhotos(files, pre = {}, opts = {}) {
  const list = [...files].filter(isPhoto);
  if (!list.length) { U.toast("Those aren't photos. Use JPG or PNG pictures of the receipts.", "error"); return []; }
  U.toast(`Saving ${list.length} receipt photo${list.length === 1 ? "" : "s"}…`);
  if (!opts.stay && S.route !== "receipts" && !document.querySelector(".modal-backdrop")) { S.ui.rcFilter = "unsent"; location.hash = "#receipts"; }
  const ids = [], errors = [];
  for (const file of list) {
    try {
      const { full, thumb } = await shrinkPhoto(file);
      const id = store.newId("receipts");
      await store.set(PHOTOS, id, { data: full.url, createdAt: U.nowISO() });
      await store.set("receipts", id, {
        kind: pre.kind || S.ui.rcKind || "in", date: pre.date || U.todayISO(), number: pre.number || "", amount: pre.amount || "",
        memberId: pre.memberId || "", memberName: pre.memberName || "", name: pre.name || pre.memberName || "",
        method: pre.method || "", chequeNo: "", bank: "", being: pre.being || "",
        paymentId: pre.paymentId || "", expenseId: pre.expenseId || "", note: "", thumb: thumb.url, w: full.w, h: full.h, bytes: full.url.length, fileName: file.name || "",
        sentAt: "", sentBy: "", createdAt: U.nowISO(), createdBy: who()
      });
      ids.push(id);
    } catch (err) {
      console.error(err);
      errors.push(err.message || String(err));
    }
  }
  if (ids.length) {
    await log(`Added ${ids.length} ${VOUCHER[pre.kind || S.ui.rcKind || "in"].toLowerCase()} photo${ids.length === 1 ? "" : "s"}${pre.name ? ` for ${pre.name}` : ""}${pre.number ? ` (no. ${pre.number})` : ""}`);
    U.toast(`Saved ${ids.length} receipt photo${ids.length === 1 ? "" : "s"}`);
  }
  errors.slice(0, 3).forEach(e => U.toast(e, "error"));
  return ids;
}

function dataUrlToFile(url, name) {
  const [head, b64] = url.split(",");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: (head.match(/:(.*?);/) || [, "image/jpeg"])[1] });
}
const receiptFileName = r => `${r.kind === "out" ? "payment-voucher" : "receipt-voucher"}-${r.date || ""}${r.number ? "-no" + r.number : ""}${r.name || r.memberName ? "-" + (r.name || r.memberName) : ""}`.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").slice(0, 80) + ".jpg";
async function photoFile(r) {
  const d = await store.get(PHOTOS, r.id);
  return d?.data ? dataUrlToFile(d.data, receiptFileName(r)) : null;
}
function downloadFile(file) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
// Only web links and WhatsApp/email links are allowed for the accountant (the setting is typed by staff).
const safeLink = s => { const v = String(s || "").trim(); return /^(https:\/\/|mailto:|whatsapp:)/i.test(v) ? v : /^chat\.whatsapp\.com\//i.test(v) ? "https://" + v : ""; };
// The message sent with the photos: receipt vouchers (money in) and payment vouchers (money out), each with a total.
function receiptSummary(list) {
  const part = (kind, title) => {
    const rows = list.filter(r => (r.kind || "in") === kind);
    if (!rows.length) return "";
    const lines = rows.map(r => `- ${[r.number ? `No. ${r.number}` : "No number", fmtDate(r.date), r.name || r.memberName, r.amount ? money(r.amount) : "", r.method, r.being].filter(Boolean).join(" · ")}`);
    const total = sum(rows, r => r.amount);
    return `${title} (${rows.length}):\n${lines.join("\n")}${total ? `\nTotal: ${money(total)}` : ""}`;
  };
  return [`${S.settings.clubName}, vouchers of ${fmtDate(U.todayISO())}`, part("in", "Receipt vouchers / سند قبض, money in"), part("out", "Payment vouchers / سند صرف, money out")].filter(Boolean).join("\n\n");
}

// Prepares the photos first, then the person taps Share (phones only share right after a tap).
async function sendReceipts(ids) {
  const queue = ids.map(id => S.receipts.find(r => r.id === id)).filter(Boolean).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (!queue.length) return U.toast("Choose the receipts to send first.", "error");
  const BATCH = 10;
  const link = safeLink(S.settings.accountantLink);
  const to = S.settings.accountantName || "the accountant";
  let done = 0, files = [], batch = [];
  const h = modal({
    title: `Send to ${to}`,
    body: `<div id="sr-body"><p class="hint">Getting the photos ready…</p></div>`,
    footer: `<footer id="sr-foot"><button type="button" class="btn" data-close>Close</button></footer>`
  });
  const body = h.el.querySelector("#sr-body"), foot = h.el.querySelector("#sr-foot");
  const markSent = async list => {
    await store.updateMany(list.map(r => ["receipts", r.id, { sentAt: U.nowISO(), sentBy: who(), sentTo: to }]));
    await log(`Sent ${list.length} receipt${list.length === 1 ? "" : "s"} to ${to}${sum(list, r => r.amount) ? ` (${money(sum(list, r => r.amount))})` : ""}`);
    S.ui.rcSel = S.ui.rcSel.filter(id => !list.some(r => r.id === id));
    done += list.length;
  };
  const step = async () => {
    batch = queue.slice(done, done + BATCH);
    if (!batch.length) {
      body.innerHTML = `<div class="callout ok">All ${queue.length} receipt${queue.length === 1 ? "" : "s"} sent to ${esc(to)} and marked as sent.</div>`;
      foot.innerHTML = `<button type="button" class="btn primary" data-close>Done</button>`;
      return;
    }
    body.innerHTML = `<p class="hint">Getting ${batch.length} photo${batch.length === 1 ? "" : "s"} ready…</p>`;
    files = (await Promise.all(batch.map(photoFile))).filter(Boolean);
    if (!h.el.isConnected) return;
    if (files.length < batch.length) U.toast(`${batch.length - files.length} photo${batch.length - files.length === 1 ? " is" : "s are"} missing and will be skipped.`, "error");
    const canShare = !!(navigator.canShare && files.length && navigator.canShare({ files }));
    const text = receiptSummary(batch);
    body.innerHTML = `
      ${queue.length > BATCH ? `<div class="callout info">${queue.length} receipts: sending them ${BATCH} at a time. ${done ? `${done} sent so far.` : ""}</div>` : ""}
      <div class="rc-strip">${batch.map(r => `<img src="${esc(r.thumb)}" alt="">`).join("")}</div>
      <label for="sr-text" style="margin-top:12px">Message with the photos</label><textarea id="sr-text" rows="5">${esc(text)}</textarea>
      <p class="hint">${canShare
        ? `Tap <b>Share</b>, choose <b>WhatsApp</b>, then <b>${esc(to)}</b>. They're marked as sent when you finish.`
        : `This browser can't attach photos to WhatsApp directly. Tap <b>Download photos</b>, then ${link ? `<b>Open ${esc(to)}</b> and drag the photos into the chat` : "send them to the accountant"}. Then tap <b>Mark as sent</b>.`}</p>`;
    foot.innerHTML = `<button type="button" class="btn left" data-close>Close</button>
      ${canShare ? `<button type="button" class="btn primary" id="sr-share">Share ${files.length} photo${files.length === 1 ? "" : "s"}</button>`
        : `<button type="button" class="btn" id="sr-dl">Download photos</button>${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open ${esc(to)}</a>` : ""}<button type="button" class="btn primary" id="sr-mark">Mark as sent</button>`}`;
    const msg = () => h.el.querySelector("#sr-text").value;
    h.el.querySelector("#sr-share")?.addEventListener("click", async () => {
      // WhatsApp sometimes drops the text when photos are shared, so it's also copied to paste in the chat.
      navigator.clipboard?.writeText(msg()).catch(() => {});
      try {
        await navigator.share({ files, text: msg() });
      } catch (err) {
        if (err.name === "AbortError") return; // closed the share menu: nothing sent
        return U.toast("Sharing didn't work: " + (err.message || err), "error");
      }
      await markSent(batch);
      U.toast(`${batch.length} marked as sent`);
      step();
    });
    h.el.querySelector("#sr-dl")?.addEventListener("click", () => {
      files.forEach((f, i) => setTimeout(() => downloadFile(f), i * 350));
      (navigator.clipboard ? navigator.clipboard.writeText(msg()) : Promise.reject())
        .then(() => U.toast("Photos downloading. The message is copied: paste it in the chat."), () => U.toast("Photos downloading."));
    });
    h.el.querySelector("#sr-mark")?.addEventListener("click", async () => { await markSent(batch); step(); });
  };
  step().catch(err => { U.toast(err.message || String(err), "error"); h.close(); });
}

function openReceiptPhoto(id) {
  const r = S.receipts.find(x => x.id === id);
  if (!r) return;
  let blobUrl = "";
  const kind0 = r.kind || "in";
  const h = modal({
    title: `${VOUCHER[kind0]}${r.number ? ` no. ${r.number}` : ""}`, wide: true,
    body: `<div class="rc-detail">
      <a class="rc-big" id="rd-big" target="_blank" rel="noopener" title="Open full size"><img id="rd-img" src="${esc(r.thumb)}" alt="Voucher photo"></a>
      <div class="fgrid">
        <div class="full"><label for="rd-kind">Type</label><select id="rd-kind" name="kind">${options([["in", "Receipt voucher (سند قبض): money in"], ["out", "Payment voucher (سند صرف): money out"]], kind0)}</select></div>
        <div><label for="rd-no">No.</label><input id="rd-no" name="number" maxlength="30" value="${esc(r.number)}" autocomplete="off" placeholder="The red number"></div>
        <div><label for="rd-date">Date</label><input id="rd-date" name="date" type="date" value="${esc(r.date)}"></div>
        <div class="full" data-k="in"><label for="rd-member">Received from (member)</label><select id="rd-member" name="memberId">${memberOptions(r.memberId)}</select></div>
        <div class="full" id="rd-name-wrap"><label for="rd-name" id="rd-name-label">Name</label><input id="rd-name" name="name" maxlength="100" value="${esc(r.memberId ? "" : r.name || "")}"></div>
        <div><label for="rd-amount">The sum of (${esc(S.settings.currency)})</label><input id="rd-amount" name="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(r.amount)}"></div>
        <div><label for="rd-method">Cash / cheque</label><select id="rd-method" name="method">${options([...new Set([...METHODS, r.method || ""])].filter(Boolean), r.method || "Cash", { blank: "—" })}</select></div>
        <div data-cheque><label for="rd-cheque">Cheque no.</label><input id="rd-cheque" name="chequeNo" maxlength="40" value="${esc(r.chequeNo)}"></div>
        <div data-cheque><label for="rd-bank">Bank</label><input id="rd-bank" name="bank" maxlength="60" value="${esc(r.bank)}"></div>
        <div class="full"><label for="rd-being">Being (what it's for)</label><input id="rd-being" name="being" maxlength="200" value="${esc(r.being)}" placeholder="e.g. 1 month MMA, gloves, electricity bill"></div>
        <div class="full" data-k="in"><label for="rd-pay">Payment in the system</label><select id="rd-pay" name="paymentId"></select></div>
        <div class="full" data-k="out"><label for="rd-exp">Expense in the system</label><select id="rd-exp" name="expenseId"></select></div>
        <div class="full"><label for="rd-note">Note</label><input id="rd-note" name="note" maxlength="200" value="${esc(r.note)}"></div>
        <div class="full hint">${r.sentAt ? `Sent to ${esc(r.sentTo || "the accountant")} ${U.fmtWhen(r.sentAt)}${r.sentBy ? ` by ${esc(r.sentBy)}` : ""}. <button type="button" class="linkish" data-act="rc-unsend" data-id="${esc(id)}">Mark as not sent</button>` : "Not sent to the accountant yet."}<br>Added ${U.fmtWhen(r.createdAt)}${r.createdBy ? ` by ${esc(r.createdBy)}` : ""}.</div>
      </div></div>`,
    footer: `<footer><button type="button" class="btn danger left" data-act="rc-del" data-id="${esc(id)}">Delete</button><button type="button" class="btn" data-act="rc-download" data-id="${esc(id)}">Download</button><button type="button" class="btn" data-act="rc-send-one" data-id="${esc(id)}">Send to accountant</button><button class="btn primary" type="submit">Save</button></footer>`,
    onOpen(el) {
      const f = el.querySelector("form");
      store.get(PHOTOS, id).then(d => {
        if (!d?.data || !el.isConnected) return;
        el.querySelector("#rd-img").src = d.data;
        blobUrl = URL.createObjectURL(dataUrlToFile(d.data, receiptFileName(r)));
        el.querySelector("#rd-big").href = blobUrl;
      }).catch(err => U.toast("Couldn't load the full photo: " + (err.message || err), "error"));
      const day = () => f.date.value || r.date || U.todayISO();
      const closest = (a, b) => Math.abs(U.diffDays(day(), a.date || day())) - Math.abs(U.diffDays(day(), b.date || day()));
      const fillLinks = () => {
        const mid = f.memberId.value;
        const pays = S.payments.filter(p => (mid ? p.memberId === mid : Math.abs(U.diffDays(day(), p.date || day())) <= 31) || p.id === r.paymentId).sort(closest).slice(0, 60);
        const pickP = f.paymentId.value || r.paymentId;
        f.paymentId.innerHTML = `<option value="">— Not linked —</option>` + pays.map(p => `<option value="${esc(p.id)}"${p.id === pickP ? " selected" : ""}>${fmtDate(p.date)} · ${esc(p.memberName || p.payerName || "—")} · ${esc(money(p.amount))}${p.bookNo ? ` · no. ${esc(p.bookNo)}` : ""}</option>`).join("");
        const exps = S.expenses.filter(x => Math.abs(U.diffDays(day(), x.date || day())) <= 31 || x.id === r.expenseId).sort(closest).slice(0, 60);
        const pickE = f.expenseId.value || r.expenseId;
        f.expenseId.innerHTML = `<option value="">— Not linked —</option>` + exps.map(x => `<option value="${esc(x.id)}"${x.id === pickE ? " selected" : ""}>${fmtDate(x.date)} · ${esc(x.description || x.category)}${x.vendor ? ` · ${esc(x.vendor)}` : ""} · ${esc(money(x.amount))}${x.voucherNo ? ` · no. ${esc(x.voucherNo)}` : ""}</option>`).join("");
      };
      // Show the fields of the chosen voucher type, and the cheque fields only for cheques.
      const sync = () => {
        const k = f.kind.value;
        el.querySelectorAll("[data-k]").forEach(n => { n.hidden = n.dataset.k !== k; });
        el.querySelector("#rd-name-wrap").hidden = k === "in" && !!f.memberId.value;
        el.querySelector("#rd-name-label").textContent = k === "in" ? "Received from (name, if not a member)" : "Paid to";
        el.querySelectorAll("[data-cheque]").forEach(n => { n.hidden = f.method.value !== "Cheque"; });
        el.querySelector("h2").textContent = `${VOUCHER[k]}${f.number.value ? ` no. ${f.number.value}` : ""}`;
      };
      f.kind.addEventListener("change", sync);
      f.method.addEventListener("change", sync);
      f.number.addEventListener("input", sync);
      f.memberId.addEventListener("change", () => { fillLinks(); sync(); });
      f.date.addEventListener("change", fillLinks);
      f.paymentId.addEventListener("change", () => {
        const p = S.payments.find(x => x.id === f.paymentId.value);
        if (!p) return;
        if (!f.amount.value) f.amount.value = p.amount;
        if (!f.number.value && p.bookNo) f.number.value = p.bookNo;
        if (!f.memberId.value && p.memberId) f.memberId.value = p.memberId;
        if (!f.memberId.value && !f.name.value) f.name.value = p.payerName || "";
        if (!f.being.value) f.being.value = p.type || "";
        if (p.method) f.method.value = p.method;
        if (p.date) f.date.value = p.date;
        sync();
      });
      f.expenseId.addEventListener("change", () => {
        const x = S.expenses.find(e => e.id === f.expenseId.value);
        if (!x) return;
        if (!f.amount.value) f.amount.value = x.amount;
        if (!f.number.value && x.voucherNo) f.number.value = x.voucherNo;
        if (!f.name.value) f.name.value = x.vendor || "";
        if (!f.being.value) f.being.value = x.description || "";
        if (x.method && [...f.method.options].some(o => o.value === x.method)) f.method.value = x.method;
        if (x.date) f.date.value = x.date;
        sync();
      });
      fillLinks();
      sync();
      const obs = new MutationObserver(() => { if (!el.isConnected) { obs.disconnect(); if (blobUrl) URL.revokeObjectURL(blobUrl); } });
      obs.observe($("modal-root"), { childList: true });
    },
    async onSubmit(d) {
      const inn = d.kind === "in";
      const m = inn ? memberById(d.memberId) : null;
      // A voucher number that matches exactly one payment (or expense) links them automatically.
      const byNo = (list, field) => { const hits = d.number ? list.filter(x => String(x[field] || "").trim() === d.number) : []; return hits.length === 1 ? hits[0] : null; };
      const p = inn ? S.payments.find(x => x.id === d.paymentId) || byNo(S.payments, "bookNo") : null;
      const x = inn ? null : S.expenses.find(e => e.id === d.expenseId) || byNo(S.expenses, "voucherNo");
      const pm = p && !m ? memberById(p.memberId) : null;
      const who2 = m || pm;
      const patch = {
        kind: d.kind, number: d.number, date: d.date, amount: d.amount === "" ? "" : num(d.amount),
        memberId: who2 ? who2.id : "", memberName: who2 ? who2.name : "", name: who2 ? who2.name : d.name || p?.payerName || x?.vendor || "",
        method: d.method, chequeNo: d.method === "Cheque" ? d.chequeNo : "", bank: d.method === "Cheque" ? d.bank : "", being: d.being,
        paymentId: p ? p.id : "", expenseId: x ? x.id : "", note: d.note
      };
      await store.update("receipts", id, patch);
      if (p && d.number && !p.bookNo) await store.update("payments", p.id, { bookNo: d.number });
      if (x && d.number && !x.voucherNo) await store.update("expenses", x.id, { voucherNo: d.number });
      await log(`Edited ${VOUCHER[d.kind].toLowerCase()} photo${d.number ? ` no. ${d.number}` : ""}${patch.name ? ` (${patch.name})` : ""}${p ? `, linked to the ${money(p.amount)} payment of ${fmtDate(p.date)}` : x ? `, linked to the expense "${x.description}" of ${fmtDate(x.date)}` : ""}`);
      U.toast((p && !d.paymentId) || (x && !d.expenseId) ? `Saved and linked by its number to the ${p ? "payment" : "expense"} of ${fmtDate((p || x).date)}` : "Saved");
    }
  });
  return h;
}

// ---------- CSV import / export ----------
const MEMBER_COLS = [["Name", "name"], ["Phone", "phone"], ["Kid or adult", "ageGroup"], ["Guardian name", "guardianName"], ["Guardian phone", "guardianPhone"], ["Programs", m => (m.programs || []).join("; ")],
  ["Status", m => stateOf(m).state], ["Plan", m => latestOf(m.id)?.plan || ""], ["Membership start", m => latestOf(m.id)?.startDate || ""], ["Membership end", m => latestOf(m.id)?.endDate || ""],
  ["Owes", m => owedOf(m).total || ""], ["Joining date", "joinDate"], ["Date of birth", "dob"], ["Cancelled on", "cancelDate"], ["Cancel reason", "cancelReason"], ["Asked to renew", m => m.cancelAskedAt ? m.cancelAskedAt.slice(0, 10) : ""], ["Answer", "cancelAnswer"], ["Email", "email"], ["Belt / rank", "belt"], ["Notes", "notes"]];
const PAY_COLS = [["Date", "date"], ["Receipt", "receipt"], ["Receipt no.", "bookNo"], ["Member / payer", p => p.memberName || p.payerName], ["Type", p => p.type || "Membership"], ["For", p => { const ms = p.membershipId ? membershipById(p.membershipId) : null; return ms ? whatOf(ms) : ""; }], ["Amount", "amount"], ["Method", "method"], ["Note", "note"], ["Recorded by", "createdBy"]];

function exportData(kind) {
  const stamp = U.todayISO();
  const files = {
    members: () => [`members-${stamp}.csv`, U.toCSV([...S.members].sort(byName), MEMBER_COLS)],
    payments: () => [`payments-${stamp}.csv`, U.toCSV([...S.payments].sort((a, b) => (a.date || "").localeCompare(b.date || "")), PAY_COLS)],
    "payments-month": () => [`payments-${S.ui.payMonth}.csv`, U.toCSV(S.payments.filter(p => (p.date || "").startsWith(S.ui.payMonth)).sort((a, b) => (a.date || "").localeCompare(b.date || "")), PAY_COLS)],
    expenses: () => [`expenses-${stamp}.csv`, U.toCSV([...S.expenses].sort((a, b) => (a.date || "").localeCompare(b.date || "")), [["Date", "date"], ["Category", "category"], ["Description", "description"], ["Paid to", "vendor"], ["Amount", "amount"], ["Status", "status"], ["Paid with", "method"], ["Due date", "dueDate"], ["Reference", "ref"], ["Notes", "notes"], ["Recorded by", "createdBy"]])],
    equipment: () => [`equipment-stock-${stamp}.csv`, U.toCSV(S.equipment, [["Item", "name"], ["For sale", e => e.forSale ? "yes" : ""], ["Category", "category"], ["Quantity", "qty"], ["Selling price", "salePrice"], ["Condition", "condition"], ["Cost per item", "unitCost"], ["Purchase date", "purchaseDate"], ["Supplier", "supplier"], ["Location", "location"], ["Next service", "serviceDue"], ["Notes", "notes"]])],
    leads: () => [`trial-requests-${stamp}.csv`, U.toCSV(S.leads, [["Received", r => (r.createdAt || "").slice(0, 10)], ["Name", "name"], ["Phone", "phone"], ["Program", "program"], ["Who", "ageGroup"], ["Best time", "preferredTime"], ["Source", "source"], ["Status", "status"], ["Trial date", "trialDate"], ["Message", "message"]])],
    attendance: () => [`attendance-${stamp}.csv`, U.toCSV([...S.attendance].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)), [["Date", "date"], ["Time", "time"], ["Member", "memberName"], ["Class", "program"], ["Checked in by", "by"]])],
    cashbook: () => [`cash-book-${S.ui.repMonth}.csv`, U.toCSV(cashBook(S.ui.repMonth, S.ui.cashMethod), [["Date", "date"], ["Particulars", "text"], ["Type / category", "sub"], ["Method", "method"], ["Cash in", r => r.inAmt || ""], ["Cash out", r => r.outAmt || ""], ["Balance", "bal"]])],
    year: () => [`summary-${S.ui.repYear}.csv`, U.toCSV(Array.from({ length: 12 }, (_, i) => monthStats(`${S.ui.repYear}-${U.pad(i + 1)}`)), [["Month", s => fmtMonth(s.m)], ["Membership income", "mem"], ["Other income", "other"], ["Total income", "inc"], ["Expenses", "exp"], ["Net", "net"], ["New members", "joined"], ["Cancellations", "cancelled"]])]
  };
  const [name, csv] = files[kind]();
  U.download(name, csv);
}

const ALIASES = {
  name: ["name", "fullname", "membername", "student", "studentname", "member", "clientname", "client"],
  phone: ["phone", "mobile", "mobileno", "mobilenumber", "phonenumber", "phoneno", "whatsapp", "contact", "contactnumber", "contactno", "tel"],
  email: ["email", "emailaddress", "mail"],
  dob: ["dateofbirth", "dob", "birthdate", "birthday"],
  guardianName: ["guardian", "guardianname", "guradianname", "parent", "parentname", "father", "fathername", "mother", "mothername"],
  guardianPhone: ["guardianphone", "parentphone", "parentmobile", "parentcontact"],
  ageGroup: ["kidoradult", "agegroup", "kidsadults", "category"],
  programs: ["programs", "program", "class", "classes", "course", "sport", "training", "activity"],
  plan: ["plan", "package", "membershiptype", "membership"],
  amount: ["packageamount", "fee", "fees", "amount", "price", "feeaed", "received"],
  startDate: ["startdate", "startingdate", "membershipstart", "joindate", "joined", "datejoined", "joiningdate", "start"],
  endDate: ["enddate", "endingdate", "membershipend", "expiry", "expirydate", "renewaldate", "end"],
  status: ["status", "state", "remarks"],
  belt: ["beltrank", "belt", "rank", "grade", "level"],
  notes: ["notes", "note", "comments", "comment"]
};

function rowsToMembers(table) {
  const head = table[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const idxs = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const i = head.findIndex(h => names.includes(h));
    if (i >= 0) idxs[key] = i;
  }
  if (idxs.name === undefined) throw new Error("Couldn't find a Name column. The first row must hold column titles like Name, Phone, Program.");
  const get = (r, k) => (idxs[k] === undefined ? "" : String(r[idxs[k]] ?? "").trim());
  return table.slice(1).map(r => {
    const progs = get(r, "programs").split(/[;,/|]+/).map(s => s.trim()).filter(Boolean)
      .map(s => PROGRAMS.find(p => p.toLowerCase() === s.toLowerCase()) || s);
    const st = get(r, "status").toLowerCase();
    return {
      name: get(r, "name"), phone: get(r, "phone"), email: get(r, "email"), dob: U.parseDate(get(r, "dob")),
      ageGroup: /kid|child/i.test(get(r, "ageGroup")) ? "Kids" : get(r, "ageGroup") ? "Adults" : "",
      guardianName: get(r, "guardianName"), guardianPhone: get(r, "guardianPhone"), programs: progs,
      plan: get(r, "plan"), amount: Number(get(r, "amount").replace(/[^0-9.]/g, "")) || 0,
      startDate: U.parseDate(get(r, "startDate")), endDate: U.parseDate(get(r, "endDate")),
      status: /cancel|left|stop|inactive/.test(st) ? "cancelled" : /pause|freeze|hold|vacation/.test(st) ? "paused" : "active",
      belt: get(r, "belt"), notes: get(r, "notes")
    };
  }).filter(m => m.name);
}

function openImportMembers() {
  let parsed = [];
  modal({
    title: "Import members from Excel (CSV)", submitLabel: "Import",
    body: `<p class="hint" style="margin-top:0">In Excel: File → Save As → <b>CSV UTF-8</b>. The first row should be the column titles. Recognised: Name, Phone, Kid or adult, Guardian name, Guardian phone, Programs, Plan, Amount, Start date, End date, Status, Belt / rank, Notes. Rows with a start date become a membership too.</p>
      <input type="file" id="imp-file" accept=".csv,text/csv">
      <label style="display:flex;gap:8px;align-items:center;margin-top:10px;color:var(--text)"><input type="checkbox" name="skipDupes" checked> Skip people already in the list (same name)</label>
      <label style="display:flex;gap:8px;align-items:center;margin-top:6px;color:var(--text)"><input type="checkbox" name="countPaid" checked> Count the amount as already paid</label>
      <div id="imp-preview" style="margin-top:12px"></div>`,
    onOpen(el) {
      el.querySelector("#imp-file").addEventListener("change", async e => {
        const file = e.target.files[0];
        const out = el.querySelector("#imp-preview");
        if (!file) return;
        try {
          parsed = rowsToMembers(U.parseCSV(await file.text()));
          out.innerHTML = parsed.length ? `<div class="callout ok">Found ${parsed.length} people (${parsed.filter(m => m.startDate).length} with a membership). First rows:</div><div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Phone</th><th>Programs</th><th>Membership</th></tr></thead><tbody>
            ${parsed.slice(0, 6).map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.phone)}</td><td>${esc(m.programs.join(", "))}</td><td>${m.startDate ? `${fmtDate(m.startDate)} – ${fmtDate(m.endDate)} · ${money(m.amount)}` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="callout warn">No rows with a name were found.</div>`;
        } catch (err) {
          parsed = [];
          out.innerHTML = `<div class="callout bad">${esc(err.message)}</div>`;
        }
      });
    },
    async onSubmit(d) {
      if (!parsed.length) { U.toast("Choose a CSV file first.", "error"); return false; }
      const existing = new Set(S.members.map(m => (m.name || "").toLowerCase().trim()));
      const rows = d.skipDupes ? parsed.filter(m => !existing.has(m.name.toLowerCase().trim())) : parsed;
      if (!rows.length) { U.toast("Everyone in that file is already in the list."); return; }
      const members = [], mss = [];
      for (const r of rows) {
        const id = "imp" + Math.random().toString(36).slice(2, 12);
        members.push({ id, name: r.name, phone: r.phone, email: r.email, dob: r.dob, ageGroup: r.ageGroup, guardianName: r.guardianName, guardianPhone: r.guardianPhone, programs: r.programs, status: r.status, belt: r.belt, notes: r.notes, joinDate: r.startDate, createdAt: U.nowISO(), createdBy: who(), ...(r.status === "cancelled" ? { cancelDate: U.todayISO(), cancelReason: "Imported as cancelled" } : {}), ...(r.status === "paused" ? { pausedFrom: U.todayISO() } : {}) });
        if (r.startDate) mss.push({ memberId: id, memberName: r.name, kind: "membership", course: r.programs[0] || "", plan: r.plan || "1 month", packageAmount: r.amount, kitAmount: 0, startDate: r.startDate, endDate: r.endDate || U.addMonthsISO(r.startDate, 1), paidBeforeImport: d.countPaid ? r.amount : 0, note: "Imported from CSV", createdAt: U.nowISO(), createdBy: who() });
      }
      await store.addMany("members", members);
      if (mss.length) await store.addMany("memberships", mss);
      await log(`Imported ${members.length} members${mss.length ? ` and ${mss.length} memberships` : ""} from CSV`);
      U.toast(`Imported ${members.length} members`);
    }
  });
}

async function backup(photos) {
  U.toast(photos ? "Preparing the backup with photos. This can take a minute…" : "Preparing the backup…");
  const data = await store.exportAll({ photos });
  U.download(`wariors-backup-${U.todayISO()}${photos ? "-with-photos" : ""}.json`, JSON.stringify(data, null, photos ? 0 : 1), "application/json");
  await log(`Downloaded a full backup${photos ? ` with ${(data[PHOTOS] || []).length} receipt photos` : ""}`);
}

function openRestore() {
  let data = null;
  modal({
    title: "Restore / import file", submitLabel: "Import",
    body: `<p class="hint" style="margin-top:0">Choose a backup downloaded from this dashboard, or a prepared import file. Records with the same ID are overwritten; everything else is kept.</p><input type="file" id="rs-file" accept=".json,application/json"><div id="rs-info" style="margin-top:10px"></div>`,
    onOpen(el) {
      el.querySelector("#rs-file").addEventListener("change", async e => {
        const info = el.querySelector("#rs-info");
        try {
          data = JSON.parse(await e.target.files[0].text());
          info.innerHTML = `<div class="callout info">File from ${U.fmtWhen(data.exportedAt)}: ${[...COLLECTIONS, PHOTOS].filter(c => (data[c] || []).length).map(c => `${(data[c] || []).length} ${c === PHOTOS ? "receipt photos" : c}`).join(", ")}${(data.settings || []).length ? ", settings" : ""}.</div>`;
        } catch {
          data = null;
          info.innerHTML = `<div class="callout bad">That file isn't a valid backup.</div>`;
        }
      });
    },
    async onSubmit() {
      if (!data) { U.toast("Choose a file first.", "error"); return false; }
      let n = 0;
      // Photos first, so no receipt ever shows without its photo.
      for (const c of [PHOTOS, ...COLLECTIONS]) if (Array.isArray(data[c]) && data[c].length) n += await store.addMany(c, data[c]);
      const st = (data.settings || []).find(s => s.id === "main");
      if (st) { const { id, ...rest } = st; await store.set("settings", "main", rest); }
      await log(`Imported ${n} records from a file of ${U.fmtWhen(data.exportedAt)}`);
      U.toast(`Imported ${n} records`);
    }
  });
}

// ---------- Settings draft ----------
function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts.at(-1)] = value;
}

async function saveSettings() {
  const d = structuredClone(S.ui.draft);
  d.renewWindow = num(d.renewWindow);
  d.plans = (d.plans || []).filter(p => String(p.name || "").trim()).map(p => ({ name: p.name.trim(), months: num(p.months), kids: num(p.kids), adults: num(p.adults) }));
  d.extraFees = (d.extraFees || []).filter(p => String(p.name || "").trim()).map(p => ({ name: p.name.trim(), kids: num(p.kids), adults: num(p.adults) }));
  d.bills = (d.bills || []).filter(b => String(b.name || "").trim()).map(b => ({ id: b.id, name: b.name.trim(), category: b.category, amount: num(b.amount), dueDay: Math.min(31, Math.max(1, num(b.dueDay) || 1)), startMonth: b.startMonth || U.thisMonth() }));
  // Rows stay in typing order while editing (so a changed day doesn't move the row under the cursor); sorted on save.
  d.schedule = (d.schedule || []).filter(s => String(s.class || "").trim() && s.from).map(s => ({ day: s.day, from: s.from, to: s.to, class: s.class.trim(), group: s.group }))
    .sort((a, b) => DAYS.findIndex(x => x[0] === a.day) - DAYS.findIndex(x => x[0] === b.day) || a.from.localeCompare(b.from));
  delete d.id;
  await store.set("settings", "main", d);
  S.settings = { ...DEFAULT_SETTINGS, ...d };
  S.ui.draft = structuredClone(S.settings);
  await log("Updated settings");
  U.toast("Settings saved");
  render();
}

// ---------- Demo data (made up; never real members) ----------
async function seedDemo() {
  store.demoClear();
  const t = U.todayISO();
  const dAgo = n => U.addDays(t, -n);
  const people = [
    ["Omar Haddad", "050 000 0101", "MMA", "Adults", 200, 20],
    ["Priya Nair", "", "Kalaripayattu", "Kids", 150, 26, { guardianName: "Anand Nair", guardianPhone: "050 000 0102" }],
    ["Yousef Khalil", "", "Karate", "Kids", 150, 31, { guardianName: "Khalil Saeed", guardianPhone: "050 000 0103", belt: "Orange belt" }],
    ["Sara Ibrahim", "050 000 0104", "Zumba", "Adults", 200, 5],
    ["Rahul Menon", "050 000 0105", "Muay Thai", "Adults", 200, 40],
    ["Fatima Zahra", "050 000 0106", "Yoga", "Adults", 200, 12],
    ["Daniel Costa", "050 000 0107", "Kickboxing", "Adults", 250, 28],
    ["Aisha Rahman", "050 000 0108", "SheFit", "Adults", 200, 2],
    ["Mariam & Ali", "", "MMA", "Kids", 300, 18, { guardianName: "Huda", guardianPhone: "050 000 0109" }],
    ["Hamza Qureshi", "050 000 0110", "Boxing", "Adults", 150, 70, { status: "cancelled", cancelDate: dAgo(35), cancelReason: "Moved away" }],
    ["Leila Hassan", "050 000 0111", "Yoga", "Adults", 200, 15, { status: "paused", pausedFrom: dAgo(3), pauseUntil: U.addDays(t, 25), pauseReason: "Vacation" }],
    ["Arjun Pillai", "", "MMA", "Kids", 150, 33, { guardianName: "Vinod Pillai", guardianPhone: "050 000 0112" }]
  ];
  const members = [], memberships = [], payments = [];
  let r = 0;
  const methods = ["Cash", "Card", "Bank transfer"];
  people.forEach(([name, phone, prog, age, price, startedDaysAgo, extra = {}], i) => {
    const id = `demo-m${i + 1}`;
    members.push({ id, name, phone, programs: [prog], ageGroup: age, status: "active", joinDate: dAgo(startedDaysAgo + 60), createdAt: U.nowISO(), createdBy: "demo", ...extra });
    for (let k = 2; k >= 0; k--) {
      const start = U.addMonthsISO(dAgo(startedDaysAgo), -k);
      const msId = `demo-ms${i + 1}-${k}`;
      const kit = k === 2 && i % 3 === 0 ? 150 : 0;
      memberships.push({ id: msId, memberId: id, memberName: name, kind: "membership", course: prog, plan: "Monthly", packageAmount: price, kitAmount: kit, startDate: start, endDate: U.addMonthsISO(start, 1), paidBeforeImport: 0, createdAt: U.nowISO(), createdBy: "demo" });
      const paid = name === "Daniel Costa" && k === 0 ? 150 : name === "Arjun Pillai" && k === 0 ? 0 : price + kit;
      if (paid) payments.push({ id: `demo-p${++r}`, memberId: id, memberName: name, membershipId: msId, type: "Membership", amount: paid, method: methods[r % 3], date: start > t ? t : start, receipt: `R-${String(r).padStart(4, "0")}`, createdAt: U.nowISO(), createdBy: "demo" });
    }
  });
  memberships.push({ id: "demo-c1", memberId: "demo-m5", memberName: "Rahul Menon", kind: "charge", chargeType: "Uniform & gear sale", description: "Gloves 12 oz", amount: 120, startDate: dAgo(6), paidBeforeImport: 0, createdAt: U.nowISO(), createdBy: "demo" });
  payments.push({ id: "demo-walk", memberId: "", memberName: "", payerName: "Walk-in", type: "Other income", amount: 20, method: "Cash", date: t, note: "One day pass", receipt: `R-${String(++r).padStart(4, "0")}`, createdAt: U.nowISO(), createdBy: "demo" });
  const ym = U.thisMonth();
  const expenses = [
    ["Electricity & water (FEWA)", "Utilities (electricity & water)", 690, "Bank transfer", `${U.addMonths(ym, -1)}-17`],
    ["Mobile bill", "Internet & phone", 197, "Bank transfer", `${U.addMonths(ym, -1)}-26`],
    ["Coach advance", "Salaries & coach fees", 500, "Cash", dAgo(9)],
    ["Fuel", "Transport & fuel", 50, "Petty cash", dAgo(4)],
    ["Tea & water", "Office supplies & refreshments", 12, "Petty cash", dAgo(2)],
    ["Washroom cleaning", "Cleaning & supplies", 25, "Petty cash", dAgo(1)]
  ].map(([description, category, amount, method, date], i) => ({ id: `demo-e${i + 1}`, description, category, amount, method, date, status: "paid", createdAt: U.nowISO(), createdBy: "demo" }));
  const equipment = [
    ["Gloves 10 oz", 3, 120], ["Gloves 12 oz", 0, 120], ["Mouth guard", 5, 40], ["Shin guard M", 2, 150], ["Hand wraps 4 m", 6, 30]
  ].map(([name, qty, salePrice], i) => ({ id: `demo-q${i + 1}`, name, qty, salePrice, forSale: true, category: "Kit for sale (stock)", condition: "New", location: "Stock (for sale)", createdAt: U.nowISO() }));
  equipment.push({ id: "demo-q9", name: "Yoga mats", qty: 15, category: "Yoga & mobility", condition: "Good", location: "Club", createdAt: U.nowISO() });
  const leads = [
    ["Khalid Mahmoud", "050 000 0201", "Kickboxing", "New", 0], ["Meera Das", "050 000 0202", "Yoga", "Trial booked", 2], ["Hassan Ali", "050 000 0203", "Karate", "Attended trial", 5]
  ].map(([name, phone, program, status, days], i) => ({ id: `demo-l${i + 1}`, name, phone, program, status, source: "Walk-in", createdAt: new Date(Date.now() - days * 864e5).toISOString() }));
  const handouts = [{ id: "demo-h1", name: "Mariam & Ali", memberId: "demo-m9", item: "T-shirt", done: false, createdAt: U.nowISO() }];
  const schedule = [["Mon", "07:00", "08:00", "Yoga", "Ladies"], ["Mon", "16:00", "17:00", "Karate", "Kids"], ["Mon", "20:00", "21:00", "Kickboxing, Muay Thai, MMA", "Adults – mix"], ["Tue", "10:00", "11:00", "Zumba", "Ladies"], ["Tue", "21:00", "22:00", "Boxing", "Adults – mix"], ["Wed", "19:00", "20:00", "Kalaripayattu", "Kids"], ["Thu", "16:00", "17:00", "Kickboxing, Muay Thai, MMA", "Kids"], ["Fri", "07:00", "08:00", "Yoga", "Ladies"], ["Sat", "20:00", "21:00", "Kalaripayattu", "Adults – mix"]]
    .map(([day, from, to, cls, group]) => ({ day, from, to, class: cls, group }));
  const settings = { ...DEFAULT_SETTINGS, plans: [{ name: "Monthly", months: 1, kids: 250, adults: 300 }, { name: "Three Months", months: 3, kids: 599, adults: 699 }, { name: "Six Months", months: 6, kids: 1099, adults: 1299 }, { name: "One Year", months: 12, kids: 1799, adults: 2099 }], extraFees: [{ name: "Registration fee", kids: 100, adults: 100 }, { name: "Uniform fee", kids: 100, adults: 100 }], schedule, bills: [{ id: "bill-ewe", name: "Electricity & water (FEWA)", category: "Utilities (electricity & water)", amount: 683, dueDay: 17, startMonth: U.addMonths(ym, -1) }] };
  await store.addMany("members", members);
  await store.addMany("memberships", memberships);
  await store.addMany("payments", payments);
  await store.addMany("expenses", expenses);
  await store.addMany("equipment", equipment);
  await store.addMany("leads", leads);
  await store.addMany("handouts", handouts);
  await store.set("settings", "main", settings);
  await store.add("activity", { at: U.nowISO(), by: "demo", text: "Loaded sample data (made-up people and prices, for trying the dashboard)" });
}

// ---------- Event wiring ----------
const ACTIONS = {
  ui(arg) { const [k, v] = arg.split("="); S.ui[k] = v; render(); },
  member: id => memberDetail(id),
  "new-member": () => openNewMember(),
  "edit-member": id => openEditMember(id),
  "new-payment": () => openPayment(),
  "pay-member": id => openPayment({ memberId: id }),
  "pay-ms"(id) { const ms = membershipById(id); openPayment({ memberId: ms.memberId, membershipId: id }); },
  "edit-ms": id => openEditMembership(id),
  async "del-ms"(id) {
    const ms = membershipById(id);
    const linked = S.payments.filter(p => p.membershipId === id).length;
    if (!(await U.confirmBox(`Delete this ${ms.kind === "charge" ? "charge" : "membership"} (${esc(whatOf(ms))})?${linked ? ` Its ${linked} payment(s) stay in the payment log.` : ""}`, { danger: true, okLabel: "Delete" }))) return;
    await store.remove("memberships", id);
    await log(`Deleted ${ms.kind === "charge" ? "charge" : "membership"} of ${ms.memberName}: ${whatOf(ms)}`);
    document.querySelectorAll(".modal-backdrop").forEach((el, i, all) => { if (i === all.length - 1) el.remove(); });
  },
  renew: id => openMembership({ memberId: id }),
  "new-membership": () => openMembership(),
  "new-charge": id => openCharge({ memberId: id }),
  async remind(id, el) {
    const m = memberById(id);
    if (!m) return;
    if (el.dataset.kind === "cancel") {
      await store.update("members", id, { cancelAskedAt: U.nowISO(), cancelAskedBy: who(), cancelAnswer: "" });
      await log(`Asked ${m.name} on WhatsApp whether they want to cancel for sure or renew`);
      return;
    }
    await store.update("members", id, { lastReminderAt: U.nowISO() });
    await log(`Sent WhatsApp ${el.dataset.kind === "renewal" ? "renewal" : "payment"} reminder to ${m.name}`);
  },
  async "cancel-answer"(id, el) {
    const m = memberById(id);
    const answer = ANSWERS[el.dataset.answer];
    await store.update("members", id, { cancelAnswer: answer, cancelAnswerAt: U.nowISO(), cancelAnswerBy: who(), ...(m.cancelAskedAt ? {} : { cancelAskedAt: U.nowISO(), cancelAskedBy: who() }) });
    await log(`${m.name} (cancelled): ${answer}`);
    if (el.dataset.answer === "renew") { U.toast(`Renew ${m.name} now: fill in the membership.`); openMembership({ memberId: id }); }
    else U.toast(`${m.name}: ${answer}`);
  },
  receipt: id => openReceipt(id),
  print() { document.body.classList.add("printing"); window.print(); setTimeout(() => document.body.classList.remove("printing"), 300); },
  "edit-payment": id => openEditPayment(id),
  "daily-report": day => openDailyReport(day),
  async "del-payment"(id) {
    const p = S.payments.find(x => x.id === id);
    if (!(await U.confirmBox(`Delete the payment of ${money(p.amount)} from ${esc(p.memberName || p.payerName)} on ${fmtDate(p.date)}? It stays in the activity log.`, { danger: true, okLabel: "Delete payment" }))) return;
    await store.remove("payments", id);
    await log(`Deleted payment ${p.receipt || ""}: ${money(p.amount)} from ${p.memberName || p.payerName} (${p.date})`);
    document.querySelectorAll(".modal-backdrop").forEach(el => { if (el.querySelector(`#ep-member`) && el.querySelector(`[data-act="del-payment"][data-id="${CSS.escape(id)}"]`)) el.remove(); });
  },
  // Receipt photos
  "rc-add"() {
    const inp = document.createElement("input");
    Object.assign(inp, { type: "file", accept: "image/*", multiple: true, hidden: true });
    inp.addEventListener("change", () => { addReceiptPhotos([...inp.files]); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  },
  "rc-open": id => openReceiptPhoto(id),
  "rc-clear"() { S.ui.rcSel = []; render(); },
  "rc-send"() {
    const sel = S.ui.rcSel.filter(id => S.receipts.some(r => r.id === id));
    sendReceipts(sel.length ? sel : S.receipts.filter(r => !r.sentAt && (!S.ui.rcType || (r.kind || "in") === S.ui.rcType)).map(r => r.id));
  },
  "rc-send-one": id => sendReceipts([id]),
  async "rc-download"(id) {
    const r = S.receipts.find(x => x.id === id);
    const f = await photoFile(r);
    if (!f) return U.toast("The full photo is missing.", "error");
    downloadFile(f);
  },
  async "rc-unsend"(id) {
    const r = S.receipts.find(x => x.id === id);
    await store.update("receipts", id, { sentAt: "", sentBy: "", sentTo: "" });
    await log(`Marked receipt photo${r.number ? ` no. ${r.number}` : ""} as not sent`);
    document.querySelectorAll(".modal-backdrop").forEach((el, i, all) => { if (i === all.length - 1) el.remove(); });
    U.toast("Marked as not sent");
  },
  async "rc-del"(id) {
    const r = S.receipts.find(x => x.id === id);
    if (!(await U.confirmBox(`Delete this receipt photo${r.number ? ` (no. ${esc(r.number)})` : ""}? This can't be undone.`, { danger: true, okLabel: "Delete photo" }))) return;
    await store.remove("receipts", id);
    await store.remove(PHOTOS, id);
    await log(`Deleted receipt photo${r.number ? ` no. ${r.number}` : ""}${r.memberName ? ` (${r.memberName})` : ""}`);
    S.ui.rcSel = S.ui.rcSel.filter(x => x !== id);
    document.querySelectorAll(".modal-backdrop").forEach(el => { if (el.querySelector("#rd-img")) el.remove(); });
    U.toast("Photo deleted");
  },
  "cancel-member": id => openCancel(id),
  "pause-member": id => openPause(id),
  async "resume-member"(id) {
    const m = memberById(id);
    await store.update("members", id, { status: "active", pausedFrom: "", pauseUntil: "", pauseReason: "" });
    await log(`Resumed membership: ${m.name}`);
    U.toast(`${m.name} is active again`);
  },
  "merge-member": id => openMerge(id),
  async "del-member"(id) {
    const m = memberById(id);
    const n = S.payments.filter(p => p.memberId === id).length;
    if (!(await U.confirmBox(`Delete ${esc(m.name)} completely? ${n ? `Their ${n} payments stay in the payment log. ` : ""}To keep their history, use <b>Cancel membership</b> instead.`, { danger: true, okLabel: "Delete member" }))) return;
    await store.remove("members", id);
    await log(`Deleted member ${m.name}`);
    U.toast(`${m.name} deleted`);
  },
  checkin: () => openCheckin(),
  "checkin-one": id => checkIn(id),
  async "del-att"(id) {
    const a = S.attendance.find(x => x.id === id);
    await store.remove("attendance", id);
    await log(`Removed check-in: ${a.memberName} on ${fmtDate(a.date)}`);
  },
  async "handout-done"(id) {
    const h = S.handouts.find(x => x.id === id);
    await store.update("handouts", id, { done: true, doneAt: U.nowISO(), doneBy: who() });
    await log(`Handed out ${h.item} to ${h.name}`);
    U.toast(`${h.item} handed out to ${h.name}`);
  },
  "new-expense": () => openExpense(),
  "edit-expense": id => openExpense({ id }),
  "pay-expense": id => openPayExpense(id),
  "pay-bill"(id, el) {
    const b = (S.settings.bills || []).find(x => x.id === id);
    const p = el.dataset.month || U.thisMonth();
    openExpense({ billId: b.id, period: p, category: b.category, description: `${b.name} – ${fmtMonth(p)}`, amount: b.amount || "", date: U.todayISO(), dueDate: `${p}-${U.pad(Math.min(num(b.dueDay) || 1, U.daysInMonth(p)))}` });
  },
  async "del-expense"(id) {
    const x = S.expenses.find(e => e.id === id);
    if (!(await U.confirmBox(`Delete "${esc(x.description || x.category)}" (${money(x.amount)})?`, { danger: true, okLabel: "Delete" }))) return;
    await store.remove("expenses", id);
    await log(`Deleted expense: ${x.description || x.category} ${money(x.amount)}`);
  },
  "new-eq": () => openEquipment(),
  "edit-eq": id => openEquipment(id),
  "sell-eq"(id) { openCharge({ equipmentId: id }); },
  "restock-eq": id => openRestock(id),
  "repair-eq"(id) {
    const e = S.equipment.find(x => x.id === id);
    openExpense({ category: "Equipment repair & service", description: `Repair: ${e.name}`, vendor: e.supplier });
  },
  async "del-eq"(id) {
    const e = S.equipment.find(x => x.id === id);
    if (!(await U.confirmBox(`Delete ${esc(e.name)}? (To keep a record, set its condition to Retired instead.)`, { danger: true, okLabel: "Delete" }))) return;
    await store.remove("equipment", id);
    await log(`Deleted equipment: ${e.name}`);
    document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
  },
  "new-lead": () => openLead(null, { source: "Walk-in" }),
  "edit-lead": id => openLead(id),
  "convert-lead"(id) {
    const l = S.leads.find(x => x.id === id);
    const prog = PROGRAMS.includes(l.program) ? [l.program] : [];
    openNewMember({ name: l.name, phone: l.phone, programs: prog, notes: l.message, ageGroup: /child|teen/i.test(l.ageGroup || "") ? "Kids" : "Adults", leadId: id });
  },
  async "del-lead"(id) {
    const l = S.leads.find(x => x.id === id);
    if (!(await U.confirmBox(`Delete the trial request from ${esc(l.name)}?`, { danger: true, okLabel: "Delete" }))) return;
    await store.remove("leads", id);
    await log(`Deleted trial request from ${l.name}`);
    document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
  },
  export: kind => exportData(kind),
  "import-members": () => openImportMembers(),
  "csv-template"() {
    U.download("members-template.csv", U.toCSV([{ name: "Example Name", phone: "050 123 4567", ageGroup: "Adults", programs: ["MMA"], plan: "Monthly", amount: 200, startDate: U.todayISO(), endDate: U.addMonthsISO(U.todayISO(), 1) }],
      [["Name", "name"], ["Phone", "phone"], ["Kid or adult", "ageGroup"], ["Guardian name", "guardianName"], ["Guardian phone", "guardianPhone"], ["Programs", m => (m.programs || []).join("; ")], ["Plan", "plan"], ["Amount", "amount"], ["Start date", "startDate"], ["End date", "endDate"], ["Status", () => "active"], ["Notes", "notes"]]));
  },
  backup: kind => backup(kind === "photos"),
  restore: () => openRestore(),
  "save-settings": () => saveSettings(),
  "reset-draft"() { S.ui.draft = null; render(); },
  "add-row"(kind) {
    const d = S.ui.draft;
    const blank = { plans: { name: "", months: 1, kids: "", adults: "" }, extraFees: { name: "", kids: "", adults: "" }, bills: { id: "bill-" + Math.random().toString(36).slice(2, 9), name: "", category: "Rent", amount: "", dueDay: 1, startMonth: U.thisMonth() }, schedule: { day: S.ui.schedDay !== "week" ? S.ui.schedDay : "Mon", from: "17:00", to: "18:00", class: "", group: "Adults – mix" } };
    (d[kind] ||= []).push(blank[kind]);
    render();
  },
  "del-row"(arg) {
    const [kind, i] = arg.split(".");
    S.ui.draft[kind].splice(Number(i), 1);
    render();
  },
  more: () => $("side").classList.add("open"),
  quick() {
    const h = modal({
      title: "Quick add",
      body: `<div class="quick-grid">
        <button type="button" class="btn primary" data-act="new-membership">New membership / renewal</button>
        <button type="button" class="btn" data-act="daily-report">Daily report</button>
        <button type="button" class="btn" data-act="new-payment">Record payment</button>
        <button type="button" class="btn" data-act="rc-add">Add receipt photos</button>
        <button type="button" class="btn" data-act="new-charge">Kit sale or other charge</button>
        <button type="button" class="btn" data-act="checkin">Check someone in</button>
        <button type="button" class="btn" data-act="new-expense">Add expense or bill</button>
        <button type="button" class="btn" data-act="new-member">Add member</button>
        <button type="button" class="btn" data-act="new-lead">Add trial request</button>
      </div>`,
      footer: `<footer><button type="button" class="btn" data-close>Close</button></footer>`
    });
    h.el.addEventListener("click", e => { if (e.target.closest("[data-act]")) h.close(); });
  },
  async "change-password"() {
    const cur = $("pw-cur").value, next = $("pw-new").value, again = $("pw-new2").value;
    if (!cur) return U.toast("Type the current password first.", "error");
    if (next.length < 8) return U.toast("The new password needs at least 8 characters.", "error");
    if (next !== again) return U.toast("The two new passwords don't match.", "error");
    try {
      await store.changePassword(cur, next);
    } catch (err) {
      return U.toast(/wrong|invalid|credential/i.test(err.code || err.message) ? "The current password is wrong." : err.message, "error");
    }
    ["pw-cur", "pw-new", "pw-new2"].forEach(id => { $(id).value = ""; });
    await log("Changed the shared login password");
    U.toast("Password changed. Tell the other admins the new one.");
  },
  async "demo-seed"() {
    if (!(await U.confirmBox("Replace everything in this browser with fresh sample data?", { okLabel: "Load sample data" }))) return;
    await seedDemo();
    U.toast("Sample data loaded");
  },
  async "demo-clear"() {
    if (!(await U.confirmBox("Delete all demo data in this browser?", { danger: true, okLabel: "Delete all" }))) return;
    store.demoClear();
    U.toast("Demo data deleted");
  }
};

document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  const external = el.tagName === "A" && el.target === "_blank";
  const nav = el.tagName === "A" && el.getAttribute("href")?.startsWith("#");
  if (!external && !nav) e.preventDefault();
  Promise.resolve(fn(el.dataset.id, el)).catch(err => { console.error(err); U.toast(err.message || String(err), "error"); });
});

document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.ui) {
    if ((el.type === "month" || el.type === "date") && !el.value) return;
    S.ui[el.dataset.ui] = el.value;
    render();
  } else if (el.dataset.draft && S.ui.draft) {
    setPath(S.ui.draft, el.dataset.draft, el.value);
  }
});

document.addEventListener("change", async e => {
  const el = e.target;
  try {
    if (el.dataset.change === "rc-files") {
      const files = [...el.files];
      el.value = "";
      await addReceiptPhotos(files);
    } else if (el.dataset.change === "rc-sel") {
      S.ui.rcSel = el.checked ? [...new Set([...S.ui.rcSel, el.dataset.id])] : S.ui.rcSel.filter(x => x !== el.dataset.id);
      render();
    } else if (el.dataset.change === "eq-cond") {
      const item = S.equipment.find(x => x.id === el.dataset.id);
      await store.update("equipment", item.id, { condition: el.value });
      await log(`Equipment condition: ${item.name} ${item.condition} → ${el.value}`);
      if (el.value === "Needs repair") U.toast(`${item.name} marked for repair. Use "Log repair" to record the cost.`);
    } else if (el.dataset.change === "lead-status") {
      const l = S.leads.find(x => x.id === el.dataset.id);
      await store.update("leads", l.id, { status: el.value });
      await log(`Trial request from ${l.name}: ${l.status || "New"} → ${el.value}`);
      if (el.value === "Joined" && !l.memberId) ACTIONS["convert-lead"](l.id);
    }
  } catch (err) {
    U.toast(err.message || String(err), "error");
  }
});

// Drag photos anywhere onto the admin: they're saved as receipts. If an open form has a photo field, they go there instead.
let dragDepth = 0;
const dragsFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
const dropDone = () => { dragDepth = 0; document.body.classList.remove("dropping"); };
document.addEventListener("dragenter", e => { if (!S.user || !dragsFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add("dropping"); });
document.addEventListener("dragover", e => { if (S.user && dragsFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
document.addEventListener("dragleave", e => { if (dragsFiles(e) && --dragDepth <= 0) dropDone(); });
document.addEventListener("drop", e => {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  dropDone();
  if (!S.user || !e.dataTransfer.files.length) return;
  const top = [...document.querySelectorAll(".modal-backdrop")].pop();
  const field = top?.querySelector("input[type=file][data-photo]");
  if (field) {
    field.files = e.dataTransfer.files;
    U.toast(`${field.files.length} photo${field.files.length === 1 ? "" : "s"} added to this form. They're saved when you press Save.`);
    return;
  }
  if (top) return U.toast("Close this window first, then drop the photos.", "error");
  addReceiptPhotos([...e.dataTransfer.files]).catch(err => U.toast(err.message || String(err), "error"));
});
window.addEventListener("dragend", dropDone);

window.addEventListener("hashchange", route);
$("menu").addEventListener("click", () => $("side").classList.toggle("open"));
$("side-scrim").addEventListener("click", () => $("side").classList.remove("open"));
$("sign-out").addEventListener("click", () => store.signOut());
$("change-person").addEventListener("click", () => { $("side").classList.remove("open"); askPerson(true); });
$("side-nav").addEventListener("click", e => { if (e.target.closest("a")) $("side").classList.remove("open"); });
new MutationObserver(() => labelTables($("modal-root"))).observe($("modal-root"), { childList: true, subtree: true });

boot();
