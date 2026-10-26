// Wariors admin dashboard: members, dues, expenses & bills, equipment, trial requests,
// attendance, reports and an automatic activity log. Data lives in Firestore (or localStorage in demo mode).
import { store, MODE, COLLECTIONS } from "../js/store.js";
import * as U from "./util.js";

const { esc, sum, fmtDate, fmtMonth, periodLabel, options } = U;

// ---------- Fixed lists ----------
const PROGRAMS = ["Karate", "Kalaripayattu", "Kickboxing", "Boxing", "MMA", "Muay Thai", "Yoga", "Zumba", "Aerobics", "Gymnastics Floor", "CrossFit", "Fitness", "EMS", "Personal Training"];
const PAY_TYPES = ["Membership", "Registration fee", "Personal training", "Grading / belt test", "Uniform & gear sale", "Event / competition", "Other income"];
const METHODS = ["Cash", "Card", "Bank transfer", "Payment link", "Cheque", "Other"];
const EXP_CATS = ["Rent", "Utilities (electricity & water)", "Internet & phone", "Equipment purchase", "Equipment repair & service", "Salaries & coach fees", "Marketing & ads", "Licences & insurance", "Cleaning & supplies", "Maintenance", "Other"];
const EQ_CATS = ["Mats & flooring", "Gloves & wraps", "Pads & shields", "Bags", "Protective gear", "Weights & strength", "Cardio machines", "EMS equipment", "Yoga & mobility", "Uniforms & belts (stock)", "Other"];
const EQ_COND = ["New", "Good", "Worn", "Needs repair", "Retired"];
const LEAD_STATUS = ["New", "Contacted", "Trial booked", "Attended trial", "Joined", "Not interested"];
const LEAD_OPEN = ["New", "Contacted", "Trial booked", "Attended trial"];
const LEAD_SOURCES = ["Website", "WhatsApp", "Walk-in", "Phone call", "Instagram", "TikTok", "Referral", "Other"];
const AGE_GROUPS = ["Adult (18+)", "Teen (13–17)", "Child (under 13)", "Family / more than one person"];
const TIMES = ["Evening", "Morning", "Weekend", "Any time"];
const CANCEL_REASONS = ["Moved away", "Too expensive", "Schedule doesn't fit", "Injury / health", "Lost interest", "Joined another club", "Goal reached / finished", "Other"];
const CYCLES = [[1, "Monthly"], [3, "Every 3 months"], [6, "Every 6 months"], [12, "Yearly"]];
const cycleName = c => (CYCLES.find(x => x[0] === Number(c)) || [0, `Every ${c} months`])[1];

const DEFAULT_SETTINGS = {
  clubName: "Wariors Martial Arts Club",
  whatsapp: "971562613563",
  currency: "AED",
  graceDays: 7,
  reminderText: "Hi {name}, this is a friendly reminder from {club} that the membership fee of {amount} for {period} is due. Thank you!",
  plans: [],
  bills: []
};

// ---------- State ----------
const S = {
  user: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  loaded: new Set(),
  members: [], payments: [], expenses: [], equipment: [], leads: [], attendance: [], activity: [],
  route: "dashboard",
  loginMsg: "",
  ui: {
    mq: "", mstatus: "active", mprog: "",
    payMonth: U.thisMonth(), payFilter: "all", payQ: "",
    expMonth: U.thisMonth(), expCat: "",
    eqQ: "", eqCond: "",
    leadFilter: "open",
    attDate: U.todayISO(),
    repYear: U.todayISO().slice(0, 4), repMonth: U.thisMonth(),
    actQ: "",
    draft: null
  }
};

const money = n => U.money(n, S.settings.currency || "AED");
const who = () => S.user?.email || "admin";
const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
const memberById = id => S.members.find(m => m.id === id);
const badge = (cls, text) => `<span class="badge ${cls}">${esc(text)}</span>`;
const STATE_BADGE = { paid: ["b-ok", "Paid"], partial: ["b-warn", "Partial"], due: ["b-info", "Due"], overdue: ["b-bad", "Overdue"], free: ["b-mute", "Free"], none: ["b-mute", "Not due"] };
const stBadge = st => badge(...STATE_BADGE[st.state]);
const memberBadge = m => m.status === "cancelled" ? badge("b-bad", "Cancelled") : m.status === "paused" ? badge("b-warn", "Paused") : badge("b-ok", "Active");
const empty = text => `<div class="empty">${text}</div>`;

async function log(text) {
  try { await store.add("activity", { at: U.nowISO(), by: who(), text }); } catch (e) { console.warn("activity log failed", e); }
}

// ---------- Membership dues ----------
// A member pays `fee` every `cycle` months, counted from the month of startDate.
// A payment covers `months` months from `forMonth`; its amount is spread evenly over them.
const cycleOf = m => Number(m.cycle) || 1;
const startMonth = m => (m.startDate || U.todayISO()).slice(0, 7);

function periodStart(m, ym) {
  const s = startMonth(m);
  const d = U.monthDiff(s, ym);
  if (d < 0) return null;
  return U.addMonths(s, Math.floor(d / cycleOf(m)) * cycleOf(m));
}
let payIndex = null; // memberId -> membership payments; rebuilt when payments change
function membershipPays(mid) {
  if (!payIndex) {
    payIndex = new Map();
    for (const p of S.payments) {
      if (!p.memberId || (p.type || "Membership") !== "Membership") continue;
      if (!payIndex.has(p.memberId)) payIndex.set(p.memberId, []);
      payIndex.get(p.memberId).push(p);
    }
  }
  return payIndex.get(mid) || [];
}
function paidForRange(m, from, len) {
  let paid = 0, last = null;
  for (const p of membershipPays(m.id)) {
    const pm = Number(p.months) || 1;
    const ov = U.overlapMonths(p.forMonth || (p.date || "").slice(0, 7), pm, from, len);
    if (ov > 0) {
      paid += (Number(p.amount) || 0) * ov / pm;
      if (!last || (p.date || "") > (last.date || "")) last = p;
    }
  }
  return { paid: Math.round(paid * 100) / 100, last };
}
// Periods from the cancel (or pause) month onward are not charged.
function stopMonth(m) {
  if (m.status === "cancelled" && m.cancelDate) return m.cancelDate.slice(0, 7);
  if (m.status === "paused" && m.pausedFrom) return m.pausedFrom.slice(0, 7);
  return null;
}
function statusFor(m, ym = U.thisMonth()) {
  const pStart = periodStart(m, ym);
  if (!pStart) return { state: "none" };
  const fee = Number(m.fee) || 0;
  const { paid, last } = paidForRange(m, pStart, cycleOf(m));
  const stop = stopMonth(m);
  if (stop && pStart >= stop && paid <= 0) return { state: "none", pStart };
  // Months before billingFrom were settled before the club started using this system.
  if (m.billingFrom && pStart < m.billingFrom && paid <= 0) return { state: "none", pStart };
  if (fee <= 0) return { state: "free", pStart, paid, fee };
  const day = Math.min(Number((m.startDate || "").slice(8, 10)) || 1, U.daysInMonth(pStart));
  const dueDate = `${pStart}-${U.pad(day)}`;
  if (paid + 0.01 >= fee) return { state: "paid", paid, fee, balance: 0, pStart, dueDate, last };
  const overdue = U.todayISO() > U.addDays(dueDate, Number(S.settings.graceDays) || 0);
  return { state: paid > 0 ? "partial" : overdue ? "overdue" : "due", overdue, paid, fee, balance: Math.round((fee - paid) * 100) / 100, pStart, dueDate, last };
}
function outstanding(m) {
  const now = U.thisMonth();
  const periods = [];
  const s = startMonth(m);
  if (s > now) return { total: 0, periods };
  for (let p = s; p <= now; p = U.addMonths(p, cycleOf(m))) {
    const st = statusFor(m, p);
    if (["due", "overdue", "partial"].includes(st.state)) periods.push(st);
  }
  return { total: sum(periods, p => p.balance), periods };
}
function defaultPeriod(m) {
  const o = outstanding(m);
  if (o.periods.length) return o.periods[0].pStart;
  const cur = periodStart(m, U.thisMonth()) || startMonth(m);
  return statusFor(m, cur).state === "paid" ? U.addMonths(cur, cycleOf(m)) : cur;
}
function duesRows(ym) {
  const rank = { overdue: 0, partial: 1, due: 2, paid: 3 };
  return S.members
    .map(m => ({ m, st: statusFor(m, ym) }))
    .filter(r => r.st.state in rank)
    .sort((a, b) => rank[a.st.state] - rank[b.st.state] || byName(a.m, b.m));
}
function reminderText(m, st) {
  const name = (m.guardianPhone && m.guardianName ? m.guardianName : m.name || "").split(" ")[0];
  return (S.settings.reminderText || DEFAULT_SETTINGS.reminderText)
    .replaceAll("{name}", name)
    .replaceAll("{amount}", money(st.balance))
    .replaceAll("{period}", periodLabel(st.pStart, cycleOf(m)))
    .replaceAll("{club}", S.settings.clubName || DEFAULT_SETTINGS.clubName);
}
function remindLink(m, st, label = "Remind") {
  const url = U.waLink(m.guardianPhone || m.phone, reminderText(m, st));
  return url ? `<a class="btn small wa" href="${esc(url)}" target="_blank" rel="noopener" data-act="remind" data-id="${esc(m.id)}" data-amount="${st.balance}" data-period="${esc(st.pStart)}">${label}</a>` : "";
}

// ---------- Bills (recurring expenses from Settings) ----------
function billRows(ym) {
  return (S.settings.bills || [])
    .filter(b => !b.startMonth || b.startMonth <= ym)
    .map(b => {
      const entry = S.expenses.find(x => x.billId === b.id && x.period === ym);
      const due = `${ym}-${U.pad(Math.min(Number(b.dueDay) || 1, U.daysInMonth(ym)))}`;
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
    $("boot").textContent = "Couldn't connect to the database. Check the internet connection and the Firebase config, then reload.";
    console.error(e);
    return;
  }
  store.onAuth(async user => {
    if (!user) return showLogin();
    if (!(await store.isAdmin(user))) {
      S.loginMsg = `${user.email} is not set up as a club admin yet. Ask the owner to add this account (see README).`;
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
      <div class="callout warn">Demo mode: no database is connected yet, so everything you enter is saved only in this browser. Connect Firebase to share data between staff (see README).</div>
      <p>Try the dashboard with realistic sample members, payments and bills, or start empty.</p>
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
      <div class="field"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="l-pass">Password</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
      <button class="btn primary" type="submit">Sign in</button>
      <p class="login-err" id="login-err">${esc(msg)}</p>
      <button class="linkish" type="button" id="forgot">Forgot password?</button>
    </form>`;
  $("login-form").onsubmit = async e => {
    e.preventDefault();
    const email = $("l-email").value.trim(), pass = $("l-pass").value;
    if (!email || !pass) { $("login-err").textContent = "Enter your email and password."; return; }
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try { await store.signIn(email, pass); }
    catch (err) { $("login-err").textContent = /invalid|wrong|not-found|credential/i.test(err.code || err.message) ? "Wrong email or password." : (err.message || "Sign-in failed."); }
    finally { btn.disabled = false; }
  };
  $("forgot").onclick = async () => {
    const email = $("l-email").value.trim();
    if (!email) { $("login-err").textContent = "Type your email above first, then press Forgot password."; return; }
    try { await store.resetPassword(email); $("login-err").textContent = "If that account exists, a reset link is on its way to " + email + "."; }
    catch (err) { $("login-err").textContent = err.message; }
  };
}

let unsubs = [];
function stopData() { unsubs.forEach(u => u && u()); unsubs = []; }

function startApp() {
  $("boot").hidden = true;
  $("login").hidden = true;
  $("app").hidden = false;
  $("who").innerHTML = `${esc(S.user.name || S.user.email)}<small>${MODE === "demo" ? "Demo mode" : "Signed in"}</small>`;
  $("banner").innerHTML = MODE === "demo" ? `<div class="banner"><b>Demo mode.</b> Data is saved only in this browser. Connect Firebase (README) before the club starts using it for real.</div>` : "";
  stopData();
  const onErr = e => U.toast("Couldn't load data: " + (e.message || e), "error");
  S.loaded = new Set();
  const sub = (col, opts) => unsubs.push(store.subscribe(col, rows => {
    S[col] = rows;
    if (col === "payments") payIndex = null;
    S.loaded.add(col);
    scheduleRender();
  }, opts, onErr));
  ["members", "payments", "expenses", "equipment", "leads"].forEach(c => sub(c));
  sub("attendance", { since: { field: "date", value: U.addDays(U.todayISO(), -120) } });
  sub("activity", { orderBy: ["at", "desc"], limit: 300 });
  unsubs.push(store.subscribeDoc("settings", "main", d => {
    const { id, ...rest } = d || {};
    S.settings = { ...DEFAULT_SETTINGS, ...rest };
    S.loaded.add("settings");
    scheduleRender();
  }, onErr));
  route();
}

// ---------- Rendering ----------
const ICONS = {
  dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  members: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  payments: "M2 5h20v14H2zM2 10h20M6 15h4",
  expenses: "M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2zM9 7h6M9 11h6M9 15h3",
  equipment: "M6.5 6.5h11M6.5 17.5h11M3 9v6M21 9v6M6.5 4v16M17.5 4v16",
  leads: "M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z",
  attendance: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  reports: "M18 20V10M12 20V4M6 20v-6",
  activity: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  settings: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"
};
const ROUTES = [
  ["dashboard", "Dashboard"], ["members", "Members"], ["payments", "Payments"], ["expenses", "Expenses & bills"],
  ["equipment", "Equipment"], ["leads", "Trial requests"], ["attendance", "Attendance"], ["reports", "Reports"],
  ["activity", "Activity log"], ["settings", "Settings"]
];

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { render(); U.refreshLive(); }, 20);
}

function navCounts() {
  const ym = U.thisMonth();
  return {
    payments: duesRows(ym).filter(r => r.st.state === "overdue" || (r.st.state === "partial" && r.st.overdue)).length,
    leads: S.leads.filter(l => l.status === "New").length,
    expenses: billRows(ym).filter(b => b.overdue).length + S.expenses.filter(x => x.status === "unpaid" && x.dueDate && x.dueDate < U.todayISO()).length
  };
}

function renderNav() {
  const c = navCounts();
  $("side-nav").innerHTML = ROUTES.map(([id, label]) =>
    `<a href="#${id}" class="${S.route === id ? "active" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[id]}"/></svg>${label}${c[id] ? `<span class="count" title="Needs attention">${c[id]}</span>` : ""}</a>`
  ).join("");
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
  if (!["members", "payments", "expenses", "settings"].every(c => S.loaded.has(c))) {
    view.innerHTML = empty("Loading club data…");
    return;
  }
  try {
    view.innerHTML = VIEWS[r[0]]();
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

// ---------- Views ----------
const kpi = (label, value, sub = "", cls = "") => `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;

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

const incomeIn = ym => sum(S.payments.filter(p => (p.date || "").startsWith(ym)), p => p.amount);
const spentIn = ym => sum(S.expenses.filter(x => x.status !== "unpaid" && (x.date || "").startsWith(ym)), x => x.amount);

function viewDashboard() {
  const ym = U.thisMonth();
  const rows = duesRows(ym);
  const unpaid = rows.filter(r => r.st.state !== "paid");
  const collected = incomeIn(ym), spent = spentIn(ym);
  const active = S.members.filter(m => m.status === "active" || !m.status).length;
  const paused = S.members.filter(m => m.status === "paused").length;
  const joined = S.members.filter(m => (m.startDate || "").startsWith(ym)).length;
  const cancelled = S.members.filter(m => m.status === "cancelled" && (m.cancelDate || "").startsWith(ym)).length;
  const newLeads = S.leads.filter(l => l.status === "New");
  const bills = billRows(ym).filter(b => b.state !== "paid");
  const unpaidInv = S.expenses.filter(x => x.status === "unpaid" && !x.billId);
  const soon = U.addDays(U.todayISO(), 14);
  const eq = S.equipment.filter(e => e.condition === "Needs repair" || (e.serviceDue && e.serviceDue <= soon && e.condition !== "Retired"));
  const pauseEnded = S.members.filter(m => m.status === "paused" && m.pauseUntil && m.pauseUntil < U.todayISO());
  const chart = Array.from({ length: 6 }, (_, i) => { const m = U.addMonths(ym, i - 5); return { label: fmtMonth(m).slice(0, 3), a: incomeIn(m), b: spentIn(m) }; });

  if (!S.members.length && !S.payments.length && !S.expenses.length) {
    return `<div class="panel"><div class="panel-body" style="padding:28px">
      <h2 style="font-size:18px;margin-bottom:8px">Welcome! Let's set up the club.</h2>
      <ol style="margin:0 0 16px;padding-left:20px;line-height:1.9">
        <li>Add your membership plans and monthly bills (rent, electricity & water, internet, salaries) in <a href="#settings">Settings</a>.</li>
        <li>Add members one by one, or import your Excel list (save it as CSV) in <a href="#settings">Settings → Import</a>.</li>
        <li>Record payments as they come in. The dashboard then shows who has paid and who hasn't, automatically.</li>
      </ol>
      <button class="btn primary" data-act="new-member">+ Add first member</button></div></div>`;
  }

  return `
    <div class="kpis">
      ${kpi(`Collected in ${fmtMonth(ym)}`, money(collected), `${S.payments.filter(p => (p.date || "").startsWith(ym)).length} payments`, "good")}
      ${kpi("Still unpaid this month", money(sum(unpaid, r => r.st.balance)), `${unpaid.length} member${unpaid.length === 1 ? "" : "s"}`, unpaid.length ? "bad" : "")}
      ${kpi(`Expenses in ${fmtMonth(ym)}`, money(spent), `${bills.length} bill${bills.length === 1 ? "" : "s"} not paid yet`)}
      ${kpi("Net this month", money(collected - spent), "collected minus expenses", collected - spent >= 0 ? "good" : "bad")}
      ${kpi("Active members", active, `${paused} paused · +${joined} joined · −${cancelled} cancelled`)}
      ${kpi("New trial requests", newLeads.length, `<a href="#leads">Open requests →</a>`, newLeads.length ? "warn" : "")}
    </div>
    <div class="cols-3">
      <div class="grid">
        <div class="panel">
          <div class="panel-head"><h2>Who hasn't paid (${fmtMonth(ym)})</h2><div class="right"><a class="btn small" href="#payments">See everyone</a></div></div>
          ${unpaid.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Period</th><th>Status</th><th class="num">Balance</th><th></th></tr></thead><tbody>
            ${unpaid.slice(0, 10).map(({ m, st }) => `<tr class="clickable" data-act="member" data-id="${esc(m.id)}">
              <td>${esc(m.name)}<span class="sub">${esc(m.phone || "")}</span></td>
              <td>${periodLabel(st.pStart, cycleOf(m))}<span class="sub">due ${fmtDate(st.dueDate)}</span></td>
              <td>${stBadge(st)}</td><td class="num">${money(st.balance)}</td>
              <td class="actions"><button class="btn small primary" data-act="pay-member" data-id="${esc(m.id)}">Mark paid</button> ${remindLink(m, st)}</td></tr>`).join("")}
          </tbody></table></div>${unpaid.length > 10 ? `<div class="panel-body hint">+ ${unpaid.length - 10} more on the Payments page.</div>` : ""}` : empty("Everyone due this month has paid. 🎉")}
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Income vs expenses</h2><div class="right legend"><span><i style="background:var(--brand)"></i>Income</span><span><i style="background:var(--muted);opacity:.55"></i>Expenses</span></div></div>
          <div class="panel-body">${barChart(chart)}</div>
        </div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="panel">
          <div class="panel-head"><h2>Bills this month</h2><div class="right"><a class="btn small" href="#expenses">Open</a></div></div>
          ${bills.length || unpaidInv.length ? `<ul class="list">${bills.map(b => `<li><div class="grow">${esc(b.b.name)}<span class="sub">due ${fmtDate(b.due)}${b.b.amount ? " · about " + money(b.b.amount) : ""}</span></div>${b.overdue ? badge("b-bad", "Overdue") : badge("b-info", b.state === "unpaid" ? "Unpaid" : "Due")}<button class="btn small" data-act="pay-bill" data-id="${esc(b.b.id)}" data-month="${ym}">Pay</button></li>`).join("")}
            ${unpaidInv.map(x => `<li><div class="grow">${esc(x.description || x.category)}<span class="sub">${esc(x.vendor || "")} · due ${fmtDate(x.dueDate)}</span></div><b>${money(x.amount)}</b><button class="btn small" data-act="pay-expense" data-id="${esc(x.id)}">Pay</button></li>`).join("")}</ul>`
            : (S.settings.bills || []).length ? empty("All bills for this month are paid.") : empty(`No monthly bills set up yet. <a href="#settings">Add rent, utilities…</a>`)}
        </div>
        ${eq.length || pauseEnded.length ? `<div class="panel"><div class="panel-head"><h2>Needs attention</h2></div><ul class="list">
          ${eq.map(e => `<li><div class="grow">${esc(e.name)}<span class="sub">${e.condition === "Needs repair" ? "Needs repair" : "Service due " + fmtDate(e.serviceDue)}</span></div><button class="btn small" data-act="edit-eq" data-id="${esc(e.id)}">Update</button></li>`).join("")}
          ${pauseEnded.map(m => `<li><div class="grow">${esc(m.name)}<span class="sub">Pause ended ${fmtDate(m.pauseUntil)}</span></div><button class="btn small" data-act="resume-member" data-id="${esc(m.id)}">Reactivate</button></li>`).join("")}
        </ul></div>` : ""}
        <div class="panel">
          <div class="panel-head"><h2>Recent activity</h2><div class="right"><a class="btn small" href="#activity">All</a></div></div>
          ${S.activity.length ? `<ul class="list feed">${S.activity.slice(0, 8).map(a => `<li><div class="grow">${esc(a.text)}<span class="sub">${esc(a.by || "")}</span></div><time>${U.fmtWhen(a.at)}</time></li>`).join("")}</ul>` : empty("Changes you make are logged here automatically.")}
        </div>
      </div>
    </div>`;
}

function viewMembers() {
  const { mq, mstatus, mprog } = S.ui;
  const counts = { active: 0, paused: 0, cancelled: 0 };
  S.members.forEach(m => counts[m.status || "active"]++);
  const q = mq.toLowerCase();
  const rows = S.members
    .filter(m => mstatus === "all" || (m.status || "active") === mstatus)
    .filter(m => !mprog || (m.programs || []).includes(mprog))
    .filter(m => !q || [m.name, m.phone, m.email, m.guardianName, m.guardianPhone].some(v => (v || "").toLowerCase().includes(q)))
    .sort(byName);
  const seg = (v, l) => `<button class="${mstatus === v ? "on" : ""}" data-act="ui" data-id="mstatus=${v}">${l}</button>`;
  return `
    <div class="toolbar">
      <input type="search" id="m-search" placeholder="Search name or phone…" value="${esc(mq)}" data-ui="mq">
      <div class="seg">${seg("active", `Active (${counts.active})`)}${seg("paused", `Paused (${counts.paused})`)}${seg("cancelled", `Cancelled (${counts.cancelled})`)}${seg("all", "All")}</div>
      <select data-ui="mprog" id="m-prog" aria-label="Program">${options(PROGRAMS, mprog, { blank: "All programs" })}</select>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="members">Export to Excel</button>
      <button class="btn primary" data-act="new-member">+ Add member</button>
    </div>
    <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>Member</th><th>Phone</th><th>Programs</th><th class="num">Fee</th><th>Member since</th><th>${mstatus === "cancelled" ? "Cancelled" : "This period"}</th><th>Last payment</th><th></th></tr></thead><tbody>
      ${rows.map(m => {
        const st = statusFor(m);
        const lastPay = [...membershipPays(m.id)].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
        const owed = outstanding(m);
        return `<tr class="clickable" data-act="member" data-id="${esc(m.id)}">
          <td><b>${esc(m.name)}</b>${m.guardianName ? `<span class="sub">Guardian: ${esc(m.guardianName)}</span>` : ""}</td>
          <td>${esc(m.phone || m.guardianPhone || "—")}</td>
          <td>${esc((m.programs || []).join(", ") || "—")}</td>
          <td class="num">${money(m.fee)}<span class="sub">${cycleName(m.cycle)}</span></td>
          <td>${fmtDate(m.startDate)}</td>
          <td>${m.status === "cancelled" ? `${fmtDate(m.cancelDate)}<span class="sub">${esc(m.cancelReason || "")}</span>` : m.status === "paused" ? `${badge("b-warn", "Paused")}<span class="sub">since ${fmtDate(m.pausedFrom)}</span>` : `${stBadge(st)}${owed.periods.length > 1 ? `<span class="sub">owes ${money(owed.total)} (${owed.periods.length} periods)</span>` : ""}`}</td>
          <td>${lastPay ? `${fmtDate(lastPay.date)}<span class="sub">${money(lastPay.amount)}</span>` : "—"}</td>
          <td class="actions">${m.status !== "cancelled" ? `<button class="btn small" data-act="pay-member" data-id="${esc(m.id)}">+ Payment</button>` : ""}</td></tr>`;
      }).join("")}</tbody></table></div>` : empty(S.members.length ? "No members match." : "No members yet. Add one, or import your Excel list from Settings.")}</div>`;
}

function viewPayments() {
  const { payMonth: ym, payFilter, payQ } = S.ui;
  const all = duesRows(ym);
  const q = payQ.toLowerCase();
  const rows = all
    .filter(r => payFilter === "all" || (payFilter === "paid" ? r.st.state === "paid" : r.st.state !== "paid"))
    .filter(r => !q || (r.m.name || "").toLowerCase().includes(q) || (r.m.phone || "").includes(q));
  const pays = S.payments.filter(p => (p.date || "").startsWith(ym)).sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.receipt || "").localeCompare(a.receipt || ""));
  const unpaid = all.filter(r => r.st.state !== "paid");
  const seg = (v, l) => `<button class="${payFilter === v ? "on" : ""}" data-act="ui" data-id="payFilter=${v}">${l}</button>`;
  return `
    <div class="toolbar">
      <button class="btn" data-act="ui" data-id="payMonth=${U.addMonths(ym, -1)}" aria-label="Previous month">‹</button>
      <input type="month" id="pay-month" value="${ym}" data-ui="payMonth" aria-label="Month">
      <button class="btn" data-act="ui" data-id="payMonth=${U.addMonths(ym, 1)}" aria-label="Next month">›</button>
      <div class="seg">${seg("all", `All (${all.length})`)}${seg("unpaid", `Not paid (${unpaid.length})`)}${seg("paid", `Paid (${all.length - unpaid.length})`)}</div>
      <input type="search" id="pay-q" placeholder="Search member…" value="${esc(payQ)}" data-ui="payQ">
      <span class="spacer"></span>
      <button class="btn primary" data-act="new-payment">+ Record payment</button>
    </div>
    <div class="kpis">
      ${kpi(`Collected in ${fmtMonth(ym)}`, money(sum(pays, p => p.amount)), `${pays.length} payments, all types`, "good")}
      ${kpi("Membership still unpaid", money(sum(unpaid, r => r.st.balance)), `${unpaid.length} of ${all.length} members`, unpaid.length ? "bad" : "")}
      ${kpi("Overdue", all.filter(r => r.st.state === "overdue" || (r.st.state === "partial" && r.st.overdue)).length, `more than ${Number(S.settings.graceDays) || 0} days late`, "warn")}
      ${kpi("Paid", all.length - unpaid.length, "members fully paid for this period")}
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h2>Who has paid: ${fmtMonth(ym)}</h2><span class="hint">Every active member is listed automatically. Members on 3, 6 or 12-month plans show the period that includes this month.</span></div>
      ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Plan</th><th>Period</th><th>Status</th><th class="num">Paid</th><th class="num">Balance</th><th>Last reminder</th><th></th></tr></thead><tbody>
        ${rows.map(({ m, st }) => `<tr class="clickable" data-act="member" data-id="${esc(m.id)}">
          <td><b>${esc(m.name)}</b><span class="sub">${esc(m.phone || m.guardianPhone || "")}</span></td>
          <td>${esc(m.plan || cycleName(m.cycle))}<span class="sub">${money(m.fee)}</span></td>
          <td>${periodLabel(st.pStart, cycleOf(m))}<span class="sub">due ${fmtDate(st.dueDate)}</span></td>
          <td>${stBadge(st)}${st.state === "partial" && st.overdue ? ` ${badge("b-bad", "Late")}` : ""}</td>
          <td class="num">${money(st.paid)}${st.last ? `<span class="sub">${fmtDate(st.last.date)} · ${esc(st.last.method || "")}</span>` : ""}</td>
          <td class="num">${st.balance ? `<b>${money(st.balance)}</b>` : "—"}</td>
          <td>${m.lastReminderAt ? U.fmtWhen(m.lastReminderAt) : "—"}</td>
          <td class="actions">${st.state !== "paid" ? `<button class="btn small primary" data-act="pay-member" data-id="${esc(m.id)}" data-month="${esc(st.pStart)}">Mark paid</button> ${remindLink(m, st)}` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : empty(all.length ? "Nobody matches this filter." : "No memberships are due in this month.")}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Payment log: ${fmtMonth(ym)}</h2><div class="right"><button class="btn small" data-act="export" data-id="payments-month">Export month</button><button class="btn small" data-act="export" data-id="payments">Export all</button></div></div>
      ${pays.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Receipt</th><th>From</th><th>Type</th><th>For</th><th>Method</th><th class="num">Amount</th><th>Recorded by</th><th></th></tr></thead><tbody>
        ${pays.map(p => `<tr><td>${fmtDate(p.date)}</td><td>${esc(p.receipt || "")}</td><td>${esc(p.memberName || p.payerName || "—")}</td><td>${esc(p.type || "Membership")}</td>
          <td>${(p.type || "Membership") === "Membership" ? periodLabel(p.forMonth, p.months) : esc(p.note || "—")}</td><td>${esc(p.method || "")}</td><td class="num">${money(p.amount)}</td>
          <td><span class="sub" style="margin:0">${esc(p.createdBy || "")}</span></td>
          <td class="actions"><button class="btn small" data-act="receipt" data-id="${esc(p.id)}">Receipt</button><button class="btn small danger" data-act="del-payment" data-id="${esc(p.id)}" aria-label="Delete payment">✕</button></td></tr>`).join("")}
      </tbody><tfoot><tr><td colspan="6">Total</td><td class="num">${money(sum(pays, p => p.amount))}</td><td colspan="2"></td></tr></tfoot></table></div>` : empty("No payments recorded in this month.")}
    </div>`;
}

function viewExpenses() {
  const { expMonth: ym, expCat } = S.ui;
  const bills = billRows(ym);
  const list = S.expenses.filter(x => (x.date || x.dueDate || "").startsWith(ym) || (x.period === ym)).filter(x => !expCat || x.category === expCat)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const paid = list.filter(x => x.status !== "unpaid");
  const unpaidAll = S.expenses.filter(x => x.status === "unpaid").sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
  const byCat = {};
  paid.forEach(x => { byCat[x.category] = (byCat[x.category] || 0) + (Number(x.amount) || 0); });
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
        </tbody></table></div>` : empty(`Add recurring bills (rent, electricity & water, internet, salaries) in <a href="#settings">Settings</a>. Each month they appear here to tick off.`)}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Unpaid bills & invoices (all months)</h2></div>
        ${unpaidAll.length ? `<ul class="list">${unpaidAll.map(x => `<li><div class="grow"><b>${esc(x.description || x.category)}</b><span class="sub">${esc(x.vendor || x.category)} · due ${fmtDate(x.dueDate)}</span></div>${x.dueDate && x.dueDate < U.todayISO() ? badge("b-bad", "Late") : ""}<b>${money(x.amount)}</b><button class="btn small primary" data-act="pay-expense" data-id="${esc(x.id)}">Pay</button></li>`).join("")}</ul>` : empty("Nothing waiting to be paid.")}
        ${cats.length ? `<div class="panel-head" style="border-top:1px solid var(--line)"><h2>Spent by category</h2></div><ul class="list">${cats.map(([c, v]) => `<li><div class="grow">${esc(c)}</div><b>${money(v)}</b></li>`).join("")}</ul>` : ""}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Expense log: ${fmtMonth(ym)}</h2></div>
      ${list.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Paid to</th><th>Method</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
        ${list.map(x => `<tr class="clickable" data-act="edit-expense" data-id="${esc(x.id)}"><td>${fmtDate(x.date || x.dueDate)}</td><td>${esc(x.category)}</td><td>${esc(x.description || "")}${x.ref ? `<span class="sub">Ref ${esc(x.ref)}</span>` : ""}</td><td>${esc(x.vendor || "")}</td><td>${esc(x.status === "unpaid" ? "" : x.method || "")}</td>
          <td>${x.status === "unpaid" ? badge("b-bad", "Unpaid") : badge("b-ok", "Paid")}</td><td class="num">${money(x.amount)}</td>
          <td class="actions">${x.status === "unpaid" ? `<button class="btn small primary" data-act="pay-expense" data-id="${esc(x.id)}">Pay</button>` : ""}<button class="btn small danger" data-act="del-expense" data-id="${esc(x.id)}" aria-label="Delete expense">✕</button></td></tr>`).join("")}
      </tbody><tfoot><tr><td colspan="6">Total paid</td><td class="num">${money(sum(paid, x => x.amount))}</td><td></td></tr></tfoot></table></div>` : empty("No expenses in this month.")}
    </div>`;
}

function viewEquipment() {
  const { eqQ, eqCond } = S.ui;
  const q = eqQ.toLowerCase();
  const rows = S.equipment.filter(e => !eqCond || e.condition === eqCond)
    .filter(e => !q || [e.name, e.category, e.supplier, e.location].some(v => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => (a.category || "").localeCompare(b.category || "") || (a.name || "").localeCompare(b.name || ""));
  const live = S.equipment.filter(e => e.condition !== "Retired");
  const soon = U.addDays(U.todayISO(), 14);
  const condBadge = c => badge({ New: "b-ok", Good: "b-ok", Worn: "b-warn", "Needs repair": "b-bad", Retired: "b-mute" }[c] || "b-mute", c || "—");
  return `
    <div class="toolbar">
      <input type="search" id="eq-q" placeholder="Search equipment…" value="${esc(eqQ)}" data-ui="eqQ">
      <select id="eq-cond" data-ui="eqCond" aria-label="Condition">${options(EQ_COND, eqCond, { blank: "Any condition" })}</select>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="equipment">Export to Excel</button>
      <button class="btn primary" data-act="new-eq">+ Add equipment</button>
    </div>
    <div class="kpis">
      ${kpi("Items in use", sum(live, e => e.qty || 1), `${live.length} lines`)}
      ${kpi("Value (purchase cost)", money(sum(live, e => (Number(e.qty) || 1) * (Number(e.unitCost) || 0))))}
      ${kpi("Needs repair", S.equipment.filter(e => e.condition === "Needs repair").length, "", S.equipment.some(e => e.condition === "Needs repair") ? "bad" : "")}
      ${kpi("Service due (14 days)", live.filter(e => e.serviceDue && e.serviceDue <= soon).length, "", "warn")}
    </div>
    <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Item</th><th>Category</th><th class="num">Qty</th><th>Condition</th><th>Bought</th><th class="num">Unit cost</th><th>Supplier</th><th>Next service</th><th></th></tr></thead><tbody>
      ${rows.map(e => `<tr><td><b>${esc(e.name)}</b>${e.location ? `<span class="sub">${esc(e.location)}</span>` : ""}${e.notes ? `<span class="sub">${esc(e.notes)}</span>` : ""}</td><td>${esc(e.category || "")}</td><td class="num">${esc(e.qty ?? 1)}</td>
        <td><select class="small" data-change="eq-cond" data-id="${esc(e.id)}" aria-label="Condition of ${esc(e.name)}" style="width:auto;padding:4px 8px">${options(EQ_COND, e.condition)}</select></td>
        <td>${fmtDate(e.purchaseDate)}</td><td class="num">${e.unitCost ? money(e.unitCost) : "—"}</td><td>${esc(e.supplier || "")}</td>
        <td>${e.serviceDue ? (e.serviceDue <= soon ? badge("b-warn", fmtDate(e.serviceDue)) : fmtDate(e.serviceDue)) : "—"}</td>
        <td class="actions"><button class="btn small" data-act="repair-eq" data-id="${esc(e.id)}">Log repair</button><button class="btn small" data-act="edit-eq" data-id="${esc(e.id)}">Edit</button></td></tr>`).join("")}
    </tbody></table></div>` : empty(S.equipment.length ? "No equipment matches." : "Track gloves, pads, bags, mats, EMS suits and more. Buying something? Add it here and it's logged as an expense too.")}</div>
    <p class="hint" style="margin-top:10px">${condBadge("Needs repair")} items and anything with a service date in the next 14 days also show on the dashboard.</p>`;
}

function viewLeads() {
  const f = S.ui.leadFilter;
  const rows = S.leads.filter(l => f === "all" || (f === "open" ? LEAD_OPEN.includes(l.status || "New") : l.status === f))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const n = s => S.leads.filter(l => (s === "open" ? LEAD_OPEN.includes(l.status || "New") : l.status === s)).length;
  const seg = (v, l) => `<button class="${f === v ? "on" : ""}" data-act="ui" data-id="leadFilter=${v}">${l}</button>`;
  const joined = S.leads.filter(l => l.status === "Joined").length;
  const closed = joined + S.leads.filter(l => l.status === "Not interested").length;
  return `
    <div class="toolbar">
      <div class="seg">${seg("open", `Open (${n("open")})`)}${seg("Joined", `Joined (${n("Joined")})`)}${seg("Not interested", `Not interested (${n("Not interested")})`)}${seg("all", "All")}</div>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="leads">Export to Excel</button>
      <button class="btn primary" data-act="new-lead">+ Add request</button>
    </div>
    <div class="kpis">
      ${kpi("New (not contacted)", n("New"), "from the website and walk-ins", n("New") ? "warn" : "")}
      ${kpi("Trials booked", n("Trial booked"))}
      ${kpi("Joined", joined, closed ? `${Math.round((joined / closed) * 100)}% of closed requests` : "")}
    </div>
    <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Received</th><th>Name</th><th>Program</th><th>Who / when</th><th>Source</th><th>Status</th><th>Trial date</th><th></th></tr></thead><tbody>
      ${rows.map(l => {
        const wa = U.waLink(l.phone, `Hi ${(l.name || "").split(" ")[0]}, thanks for your interest in ${S.settings.clubName}! When would you like to come for your free ${l.program && l.program !== "Not sure yet" ? l.program + " " : ""}trial class?`);
        return `<tr><td>${fmtDate(l.createdAt)}</td><td><b>${esc(l.name)}</b><span class="sub">${esc(l.phone || "")}</span>${l.message ? `<span class="sub">“${esc(l.message)}”</span>` : ""}</td>
        <td>${esc(l.program || "—")}</td><td>${esc(l.ageGroup || "")}<span class="sub">${esc(l.preferredTime || "")}</span></td><td>${esc(l.source || "")}</td>
        <td><select data-change="lead-status" data-id="${esc(l.id)}" aria-label="Status of ${esc(l.name)}" style="width:auto;padding:4px 8px">${options(LEAD_STATUS, l.status || "New")}</select></td>
        <td>${l.trialDate ? fmtDate(l.trialDate) : "—"}</td>
        <td class="actions">${wa ? `<a class="btn small wa" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}${l.status !== "Joined" ? `<button class="btn small primary" data-act="convert-lead" data-id="${esc(l.id)}">Make member</button>` : ""}<button class="btn small" data-act="edit-lead" data-id="${esc(l.id)}">Edit</button></td></tr>`;
      }).join("")}
    </tbody></table></div>` : empty(S.leads.length ? "Nothing in this list." : "Free-trial requests from the website's form land here automatically.")}</div>`;
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
  const away = S.attendance.length ? S.members.filter(m => (m.status || "active") === "active" && m.startDate <= cutoff && (!last[m.id] || last[m.id] < cutoff))
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
        ${day.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Time</th><th>Member</th><th>Class</th><th></th></tr></thead><tbody>
          ${day.map(a => `<tr><td>${esc(a.time || "")}</td><td>${esc(a.memberName || memberById(a.memberId)?.name || "—")}</td><td>${esc(a.program || "")}</td><td class="actions"><button class="btn small danger" data-act="del-att" data-id="${esc(a.id)}" aria-label="Remove check-in">✕</button></td></tr>`).join("")}
        </tbody></table></div>` : empty("No check-ins on this day.")}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Haven't trained in 14+ days</h2><span class="hint">A friendly message often keeps them coming.</span></div>
        ${S.attendance.length ? (away.length ? `<ul class="list">${away.map(m => {
          const wa = U.waLink(m.guardianPhone || m.phone, `Hi ${(m.name || "").split(" ")[0]}, we've missed you at ${S.settings.clubName}! Hope all is well. See you on the mat soon?`);
          return `<li><div class="grow"><button class="linkish" data-act="member" data-id="${esc(m.id)}">${esc(m.name)}</button><span class="sub">${last[m.id] ? "Last visit " + fmtDate(last[m.id]) : "No visits recorded"}</span></div>${wa ? `<a class="btn small wa" href="${esc(wa)}" target="_blank" rel="noopener">Message</a>` : ""}</li>`;
        }).join("")}</ul>` : empty("Everyone has trained in the last two weeks.")) : empty("Start checking members in and this list fills itself.")}
      </div>
    </div>`;
}

function viewReports() {
  const y = S.ui.repYear, ym = S.ui.repMonth;
  const months = Array.from({ length: 12 }, (_, i) => `${y}-${U.pad(i + 1)}`);
  const stats = months.map(m => {
    const ps = S.payments.filter(p => (p.date || "").startsWith(m));
    const mem = sum(ps.filter(p => (p.type || "Membership") === "Membership"), p => p.amount);
    const other = sum(ps, p => p.amount) - mem;
    const exp = spentIn(m);
    return { m, mem, other, inc: mem + other, exp, net: mem + other - exp, joined: S.members.filter(x => (x.startDate || "").startsWith(m)).length, cancelled: S.members.filter(x => x.status === "cancelled" && (x.cancelDate || "").startsWith(m)).length };
  });
  const tot = k => sum(stats, s => s[k]);
  const years = [...new Set([U.todayISO().slice(0, 4), ...S.payments.map(p => (p.date || "").slice(0, 4)), ...S.expenses.map(x => (x.date || "").slice(0, 4))].filter(Boolean))].sort().reverse();
  const group = (rows, key, val) => { const g = {}; rows.forEach(r => { const k = key(r) || "—"; g[k] = (g[k] || 0) + (Number(val(r)) || 0); }); return Object.entries(g).sort((a, b) => b[1] - a[1]); };
  const mp = S.payments.filter(p => (p.date || "").startsWith(ym));
  const me = S.expenses.filter(x => x.status !== "unpaid" && (x.date || "").startsWith(ym));
  const byType = group(mp, p => p.type || "Membership", p => p.amount);
  const byMethod = group(mp, p => p.method, p => p.amount);
  const byProg = group(mp.filter(p => p.memberId), p => (memberById(p.memberId)?.programs || [])[0] || "Other", p => p.amount);
  const byCat = group(me, x => x.category, x => x.amount);
  const cancels = S.members.filter(m => m.status === "cancelled" && (m.cancelDate || "").startsWith(ym));
  const reasons = group(S.members.filter(m => m.status === "cancelled"), m => m.cancelReason, () => 1);
  const mini = (title, rows, fmt = money) => `<div class="panel"><div class="panel-head"><h2>${title}</h2></div>${rows.length ? `<ul class="list">${rows.map(([k, v]) => `<li><div class="grow">${esc(k)}</div><b>${fmt(v)}</b></li>`).join("")}</ul>` : empty("Nothing yet.")}</div>`;
  return `
    <div class="toolbar">
      <label for="rep-year" style="margin:0">Year</label>
      <select id="rep-year" data-ui="repYear" style="width:auto">${options(years, y)}</select>
      <span class="spacer"></span>
      <button class="btn" data-act="export" data-id="year">Export year summary</button>
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h2>${esc(y)} month by month</h2><span class="hint">Income counts payments by the date they were received. Expenses count paid bills only.</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Month</th><th class="num">Memberships</th><th class="num">Other income</th><th class="num">Total income</th><th class="num">Expenses</th><th class="num">Net</th><th class="num">Joined</th><th class="num">Cancelled</th></tr></thead><tbody>
        ${stats.map(s => `<tr class="clickable" data-act="ui" data-id="repMonth=${s.m}"${s.m === ym ? ' style="outline:2px solid var(--brand);outline-offset:-2px"' : ""}><td>${fmtMonth(s.m)}</td><td class="num">${money(s.mem)}</td><td class="num">${money(s.other)}</td><td class="num"><b>${money(s.inc)}</b></td><td class="num">${money(s.exp)}</td><td class="num" style="color:${s.net < 0 ? "var(--bad)" : "inherit"}">${money(s.net)}</td><td class="num">${s.joined}</td><td class="num">${s.cancelled}</td></tr>`).join("")}
      </tbody><tfoot><tr><td>Total</td><td class="num">${money(tot("mem"))}</td><td class="num">${money(tot("other"))}</td><td class="num">${money(tot("inc"))}</td><td class="num">${money(tot("exp"))}</td><td class="num">${money(tot("net"))}</td><td class="num">${tot("joined")}</td><td class="num">${tot("cancelled")}</td></tr></tfoot></table></div>
    </div>
    <div class="toolbar"><h2 style="font-size:16px">Breakdown for</h2><input type="month" id="rep-month" value="${ym}" data-ui="repMonth" style="width:auto" aria-label="Month"><span class="hint">Click a row above to switch month.</span></div>
    <div class="cols-2" style="margin-bottom:16px">
      ${mini("Income by type", byType)}
      ${mini("Income by payment method", byMethod)}
      ${mini("Income by program", byProg)}
      ${mini("Expenses by category", byCat)}
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
    <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th style="width:190px">When</th><th>What happened</th><th>By</th></tr></thead><tbody>
      ${rows.map(a => `<tr><td>${U.fmtWhen(a.at)}</td><td>${esc(a.text)}</td><td>${esc(a.by || "")}</td></tr>`).join("")}
    </tbody></table></div>` : empty("Nothing logged yet.")}</div>`;
}

function viewSettings() {
  if (!S.ui.draft) S.ui.draft = structuredClone({ ...DEFAULT_SETTINGS, ...S.settings });
  const d = S.ui.draft;
  const planRows = (d.plans || []).map((p, i) => `<div class="row">
      <input data-draft="plans.${i}.name" value="${esc(p.name)}" placeholder="Plan name, e.g. Karate kids – monthly" aria-label="Plan name">
      <input type="number" min="0" step="1" data-draft="plans.${i}.fee" value="${esc(p.fee)}" placeholder="Fee" aria-label="Fee">
      <select data-draft="plans.${i}.cycle" aria-label="Billing cycle">${options(CYCLES, Number(p.cycle) || 1)}</select>
      <button class="btn small danger" data-act="del-row" data-id="plans.${i}" aria-label="Remove plan">✕</button></div>`).join("");
  const billRowsHtml = (d.bills || []).map((b, i) => `<div class="row">
      <input data-draft="bills.${i}.name" value="${esc(b.name)}" placeholder="Bill name, e.g. Rent" aria-label="Bill name">
      <select data-draft="bills.${i}.category" aria-label="Category">${options(EXP_CATS, b.category)}</select>
      <input type="number" min="0" step="1" data-draft="bills.${i}.amount" value="${esc(b.amount || "")}" placeholder="Usual amount" aria-label="Usual amount">
      <input type="number" min="1" max="31" data-draft="bills.${i}.dueDay" value="${esc(b.dueDay || 1)}" placeholder="Due day" aria-label="Due day of month">
      <button class="btn small danger" data-act="del-row" data-id="bills.${i}" aria-label="Remove bill">✕</button></div>`).join("");
  return `
    <div class="grid" style="max-width:980px">
      <div class="panel"><div class="panel-head"><h2>Club details</h2></div><div class="panel-body fgrid">
        <div><label for="s-name">Club name</label><input id="s-name" data-draft="clubName" value="${esc(d.clubName)}"></div>
        <div><label for="s-wa">Club WhatsApp number</label><input id="s-wa" data-draft="whatsapp" value="${esc(d.whatsapp)}"></div>
        <div><label for="s-cur">Currency</label><input id="s-cur" data-draft="currency" value="${esc(d.currency)}"></div>
        <div><label for="s-grace">Days before a payment counts as late</label><input id="s-grace" type="number" min="0" max="60" data-draft="graceDays" value="${esc(d.graceDays)}"></div>
        <div class="full"><label for="s-rem">WhatsApp payment reminder</label><textarea id="s-rem" data-draft="reminderText">${esc(d.reminderText)}</textarea><span class="hint">Placeholders: {name} {amount} {period} {club}</span></div>
      </div></div>

      <div class="panel"><div class="panel-head"><h2>Membership plans</h2><span class="hint">Used to fill in the fee when you add a member. You can still type any fee.</span></div>
        <div class="panel-body rows-edit">${planRows || `<p class="hint">No plans yet.</p>`}<button class="btn small" data-act="add-row" data-id="plans">+ Add plan</button></div></div>

      <div class="panel"><div class="panel-head"><h2>Monthly bills</h2><span class="hint">Rent, electricity & water, internet, salaries… They appear every month under Expenses so nothing is forgotten.</span></div>
        <div class="panel-body rows-edit bills">${billRowsHtml || `<p class="hint">No recurring bills yet.</p>`}<button class="btn small" data-act="add-row" data-id="bills">+ Add bill</button></div></div>

      <div><button class="btn primary" data-act="save-settings">Save settings</button> <button class="btn" data-act="reset-draft">Undo changes</button></div>

      <div class="panel"><div class="panel-head"><h2>Import & backup</h2></div><div class="panel-body grid">
        <div><b>Move from Excel.</b> <span class="hint">In Excel choose File → Save As → CSV, then import. Columns are matched by their names (Name, Phone, Program, Fee, Start date…).</span>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="import-members">Import members from CSV</button><button class="btn" data-act="csv-template">Download template</button></div></div>
        <div><b>Backup.</b> <span class="hint">Download everything as one file (keep it somewhere safe), or restore from a backup.</span>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="backup">Download full backup</button><button class="btn" data-act="restore">Restore from backup</button></div></div>
      </div></div>

      ${MODE === "demo" ? `<div class="panel"><div class="panel-head"><h2>Demo data</h2></div><div class="panel-body" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" data-act="demo-seed">Reload sample data</button><button class="btn danger" data-act="demo-clear">Delete all demo data</button></div></div>`
        : `<div class="panel"><div class="panel-head"><h2>Staff logins</h2></div><div class="panel-body hint">To give someone access: Firebase console → Authentication → Add user (email + password). Then in Firestore, create a document in the <b>admins</b> collection whose ID is that user's UID. Remove the document to take access away.</div></div>`}
    </div>`;
}

const VIEWS = { dashboard: viewDashboard, members: viewMembers, payments: viewPayments, expenses: viewExpenses, equipment: viewEquipment, leads: viewLeads, attendance: viewAttendance, reports: viewReports, activity: viewActivity, settings: viewSettings };

// ---------- Forms ----------
function nextReceipt() {
  const n = Math.max(0, ...S.payments.map(p => Number(String(p.receipt || "").replace(/\D/g, "")) || 0));
  return `R-${String(n + 1).padStart(4, "0")}`;
}

function memberOptions(selected) {
  const groups = [["active", "Active"], ["paused", "Paused"], ["cancelled", "Cancelled"]];
  return groups.map(([s, l]) => {
    const ms = S.members.filter(m => (m.status || "active") === s).sort(byName);
    return ms.length ? `<optgroup label="${l}">${ms.map(m => `<option value="${esc(m.id)}"${m.id === selected ? " selected" : ""}>${esc(m.name)}${m.phone ? " · " + esc(m.phone) : ""}</option>`).join("")}</optgroup>` : "";
  }).join("");
}

function openPayment(pre = {}) {
  const m0 = pre.memberId ? memberById(pre.memberId) : null;
  modal({
    title: "Record payment",
    submitLabel: "Save payment",
    body: `<div class="fgrid">
      <div class="full"><label for="p-member">Member</label><select id="p-member" name="memberId"><option value="">— Not a member / walk-in —</option>${memberOptions(pre.memberId)}</select></div>
      <div class="full" id="p-payer-wrap"><label for="p-payer">Paid by (name) *</label><input id="p-payer" name="payerName" maxlength="100"></div>
      <div><label for="p-type">Type</label><select id="p-type" name="type">${options(PAY_TYPES, pre.type || "Membership")}</select></div>
      <div><label for="p-amount">Amount (${esc(S.settings.currency)}) *</label><input id="p-amount" name="amount" type="number" min="0" step="0.01" required></div>
      <div class="p-mem"><label for="p-for">For month</label><input id="p-for" name="forMonth" type="month"></div>
      <div class="p-mem"><label for="p-months">Months covered</label><input id="p-months" name="months" type="number" min="1" max="24" step="1" value="1"></div>
      <div><label for="p-method">Method</label><select id="p-method" name="method">${options(METHODS, "Cash")}</select></div>
      <div><label for="p-date">Date received</label><input id="p-date" name="date" type="date" value="${U.todayISO()}" required></div>
      <div class="full"><label for="p-note">Note</label><input id="p-note" name="note" maxlength="200" placeholder="Optional"></div>
      <div class="full" id="p-hint"></div>
    </div>`,
    onOpen(el) {
      const f = el.querySelector("form");
      const sync = (resetDefaults) => {
        const m = memberById(f.memberId.value);
        const isMem = f.type.value === "Membership";
        el.querySelector("#p-payer-wrap").hidden = !!m;
        f.payerName.required = !m;
        el.querySelectorAll(".p-mem").forEach(x => { x.hidden = !isMem || !m; });
        let hint = "";
        if (m && isMem) {
          if (resetDefaults) {
            f.forMonth.value = pre.forMonth || defaultPeriod(m);
            f.months.value = cycleOf(m);
          }
          const months = Number(f.months.value) || cycleOf(m);
          const from = f.forMonth.value || defaultPeriod(m);
          const already = paidForRange(m, from, months).paid;
          const expected = Math.round((Number(m.fee) || 0) * months / cycleOf(m) * 100) / 100;
          if (resetDefaults || !f.amount.value) f.amount.value = Math.max(0, Math.round((expected - already) * 100) / 100) || "";
          const o = outstanding(m);
          hint = `<div class="callout ${o.total ? "warn" : "info"}">${esc(m.name)} pays ${money(m.fee)} ${cycleName(m.cycle).toLowerCase()}. ${already ? `Already paid ${money(already)} for ${periodLabel(from, months)}. ` : ""}${o.total ? `Owes ${money(o.total)} in total (${o.periods.map(p => periodLabel(p.pStart, cycleOf(m))).join(", ")}).` : "Nothing overdue."}</div>`;
        }
        el.querySelector("#p-hint").innerHTML = hint;
      };
      f.memberId.addEventListener("change", () => { f.amount.value = ""; sync(true); });
      f.type.addEventListener("change", () => sync(false));
      f.months.addEventListener("input", () => { f.amount.value = ""; sync(false); });
      f.forMonth.addEventListener("change", () => { f.amount.value = ""; sync(false); });
      sync(true);
      if (pre.amount) f.amount.value = pre.amount;
    },
    async onSubmit(d) {
      const m = memberById(d.memberId);
      if (!(Number(d.amount) > 0)) { U.toast("Enter an amount above zero.", "error"); return false; }
      const isMem = d.type === "Membership" && m;
      const p = {
        memberId: m ? m.id : "", memberName: m ? m.name : "", payerName: m ? "" : d.payerName,
        type: d.type, amount: Number(d.amount), method: d.method, date: d.date,
        forMonth: isMem ? (d.forMonth || defaultPeriod(m)) : "", months: isMem ? Number(d.months) || 1 : 0,
        note: d.note, receipt: nextReceipt(), createdAt: U.nowISO(), createdBy: who()
      };
      const id = await store.add("payments", p);
      await log(`Recorded payment ${p.receipt}: ${money(p.amount)} from ${p.memberName || p.payerName} (${p.type}${isMem ? ", " + periodLabel(p.forMonth, p.months) : ""}, ${p.method})`);
      U.toast(`Saved ${p.receipt}: ${money(p.amount)}`);
      if (pre.afterSave) pre.afterSave(id);
    }
  });
  if (m0 && m0.status === "cancelled") U.toast(`${m0.name} has cancelled. You can still record a payment.`);
}

const modal = U.modal;

function memberForm(m = {}) {
  const plans = S.settings.plans || [];
  const progs = new Set(m.programs || []);
  return `<div class="fgrid">
    <div><label for="mf-name">Full name *</label><input id="mf-name" name="name" required maxlength="100" value="${esc(m.name)}"></div>
    <div><label for="mf-phone">Phone / WhatsApp *</label><input id="mf-phone" name="phone" type="tel" maxlength="30" value="${esc(m.phone)}" placeholder="05X XXX XXXX"></div>
    <div><label for="mf-email">Email</label><input id="mf-email" name="email" type="email" maxlength="120" value="${esc(m.email)}"></div>
    <div><label for="mf-dob">Date of birth</label><input id="mf-dob" name="dob" type="date" value="${esc(m.dob)}"></div>
    <div><label for="mf-gname">Parent / guardian (for kids)</label><input id="mf-gname" name="guardianName" maxlength="100" value="${esc(m.guardianName)}"></div>
    <div><label for="mf-gphone">Guardian phone</label><input id="mf-gphone" name="guardianPhone" type="tel" maxlength="30" value="${esc(m.guardianPhone)}"></div>
    <div class="full"><label>Programs</label><div class="checks">${PROGRAMS.map(p => `<label><input type="checkbox" name="programs" data-multi value="${esc(p)}"${progs.has(p) ? " checked" : ""}>${esc(p)}</label>`).join("")}</div></div>
    <div><label for="mf-plan">Plan</label><select id="mf-plan" name="plan">${options(plans.map(p => p.name), m.plan, { blank: plans.length ? "Custom fee" : "Custom fee (add plans in Settings)" })}</select></div>
    <div><label for="mf-fee">Fee (${esc(S.settings.currency)}) *</label><input id="mf-fee" name="fee" type="number" min="0" step="0.01" required value="${esc(m.fee ?? "")}"></div>
    <div><label for="mf-cycle">Billing</label><select id="mf-cycle" name="cycle">${options(CYCLES, Number(m.cycle) || 1)}</select></div>
    <div><label for="mf-start">Start date (billing day) *</label><input id="mf-start" name="startDate" type="date" required value="${esc(m.startDate || U.todayISO())}"></div>
    <div><label for="mf-from">Track fees from (month)</label><input id="mf-from" name="billingFrom" type="month" value="${esc(m.billingFrom || "")}"><span class="hint">For members who joined before you used this system: earlier months count as settled. Leave empty to track from the start date.</span></div>
    <div><label for="mf-belt">Belt / rank</label><input id="mf-belt" name="belt" maxlength="60" value="${esc(m.belt)}" placeholder="e.g. Yellow belt"></div>
    <div><label for="mf-em">Emergency contact</label><input id="mf-em" name="emergency" maxlength="120" value="${esc(m.emergency)}" placeholder="Name and phone"></div>
    <div class="full"><label for="mf-notes">Notes (medical, injuries, anything useful)</label><textarea id="mf-notes" name="notes" maxlength="2000">${esc(m.notes)}</textarea></div>
  </div>`;
}
function wirePlan(el) {
  const f = el.querySelector("form");
  f.plan.addEventListener("change", () => {
    const p = (S.settings.plans || []).find(x => x.name === f.plan.value);
    if (p) { f.fee.value = p.fee; f.cycle.value = String(Number(p.cycle) || 1); }
  });
}
function memberData(d) {
  if (!d.phone && !d.guardianPhone) throw new Error("Add a phone number (the member's or the guardian's).");
  return { name: d.name, phone: d.phone, email: d.email, dob: d.dob, guardianName: d.guardianName, guardianPhone: d.guardianPhone, programs: d.programs || [], plan: d.plan, fee: Number(d.fee) || 0, cycle: Number(d.cycle) || 1, startDate: d.startDate, billingFrom: d.billingFrom || "", belt: d.belt, emergency: d.emergency, notes: d.notes };
}

function openNewMember(pre = {}) {
  modal({
    title: "Add member", submitLabel: "Add member", wide: true,
    body: memberForm(pre),
    onOpen: wirePlan,
    async onSubmit(d) {
      const data = { ...memberData(d), status: "active", createdAt: U.nowISO(), createdBy: who() };
      const id = await store.add("members", data);
      await log(`Added member ${data.name} (${(data.programs || []).join(", ") || "no program"}, ${money(data.fee)} ${cycleName(data.cycle).toLowerCase()})`);
      U.toast(`${data.name} added`);
      if (pre.leadId) {
        await store.update("leads", pre.leadId, { status: "Joined", memberId: id });
        await log(`Trial request from ${data.name} → Joined`);
      }
      if (d.payNow) openPayment({ memberId: id });
    },
    footer: `<footer><label class="left" style="display:flex;gap:6px;align-items:center;margin:0;color:var(--text)"><input type="checkbox" name="payNow" checked> Record first payment next</label><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add member</button></footer>`
  });
}

function openEditMember(id) {
  const m = memberById(id);
  if (!m) return;
  modal({
    title: `Edit ${m.name}`, wide: true,
    body: memberForm(m),
    onOpen: wirePlan,
    async onSubmit(d) {
      const data = memberData(d);
      const changes = Object.keys(data).filter(k => JSON.stringify(data[k] ?? "") !== JSON.stringify(m[k] ?? "")).map(k => k === "fee" ? `fee ${money(m.fee)} → ${money(data.fee)}` : k);
      await store.update("members", id, data);
      if (changes.length) await log(`Edited member ${data.name}: ${changes.join(", ")}`);
      U.toast("Saved");
    }
  });
}

function memberDetail(id) {
  modal({
    title: "Member", wide: true,
    live: () => {
      const m = memberById(id);
      if (!m) return null;
      const st = statusFor(m);
      const o = outstanding(m);
      const pays = S.payments.filter(p => p.memberId === id).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      const visits = S.attendance.filter(a => a.memberId === id);
      const v30 = visits.filter(a => a.date >= U.addDays(U.todayISO(), -30)).length;
      const lastV = visits.map(a => a.date).sort().pop();
      const age = U.ageFrom(m.dob);
      const wa = U.waLink(m.phone);
      const gwa = U.waLink(m.guardianPhone);
      const firstDue = o.periods[0];
      return `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px"><h3 style="font-size:20px">${esc(m.name)}</h3>${memberBadge(m)}${m.status !== "cancelled" && m.status !== "paused" ? stBadge(st) : ""}</div>
        ${o.total ? `<div class="callout bad">Owes <b>${money(o.total)}</b> for ${o.periods.map(p => periodLabel(p.pStart, cycleOf(m))).join(", ")}.</div>` : ""}
        ${m.status === "cancelled" ? `<div class="callout info">Cancelled on ${fmtDate(m.cancelDate)}${m.cancelReason ? ` · ${esc(m.cancelReason)}` : ""}${m.cancelNote ? ` · ${esc(m.cancelNote)}` : ""}</div>` : ""}
        ${m.status === "paused" ? `<div class="callout warn">Paused since ${fmtDate(m.pausedFrom)}${m.pauseUntil ? ` until ${fmtDate(m.pauseUntil)}` : ""}${m.pauseReason ? ` · ${esc(m.pauseReason)}` : ""}. No fees are due while paused.</div>` : ""}
        <div class="dl">
          <div><b>Phone</b>${esc(m.phone || "—")}${wa ? ` · <a href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}</div>
          ${m.email ? `<div><b>Email</b><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></div>` : ""}
          ${m.dob ? `<div><b>Age</b>${age !== "" ? age + " years" : "—"} <span class="hint">(${fmtDate(m.dob)})</span></div>` : ""}
          ${m.guardianName || m.guardianPhone ? `<div><b>Guardian</b>${esc(m.guardianName || "")} ${esc(m.guardianPhone || "")}${gwa ? ` · <a href="${esc(gwa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}</div>` : ""}
          <div><b>Programs</b>${esc((m.programs || []).join(", ") || "—")}</div>
          <div><b>Fee</b>${money(m.fee)} · ${cycleName(m.cycle)}${m.plan ? `<br><span class="hint">${esc(m.plan)}</span>` : ""}</div>
          <div><b>Member since</b>${fmtDate(m.startDate)}<br><span class="hint">billed on day ${Number((m.startDate || "").slice(8, 10)) || 1}</span></div>
          ${m.belt ? `<div><b>Belt / rank</b>${esc(m.belt)}</div>` : ""}
          <div><b>Visits (30 days)</b>${v30}${lastV ? `<br><span class="hint">last ${fmtDate(lastV)}</span>` : ""}</div>
          ${m.emergency ? `<div><b>Emergency</b>${esc(m.emergency)}</div>` : ""}
          ${m.lastReminderAt ? `<div><b>Last reminder</b>${U.fmtWhen(m.lastReminderAt)}</div>` : ""}
        </div>
        ${m.notes ? `<div class="callout info" style="white-space:pre-wrap">${esc(m.notes)}</div>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn primary" data-act="pay-member" data-id="${esc(id)}">+ Record payment</button>
          ${firstDue ? remindLink(m, { ...firstDue, balance: o.total }, "Send reminder") : ""}
          ${m.status !== "cancelled" ? `<button type="button" class="btn" data-act="checkin-one" data-id="${esc(id)}">Check in now</button>` : ""}
          <button type="button" class="btn" data-act="edit-member" data-id="${esc(id)}">Edit</button>
          ${m.status === "active" || !m.status ? `<button type="button" class="btn" data-act="pause-member" data-id="${esc(id)}">Pause</button>` : ""}
          ${m.status === "paused" ? `<button type="button" class="btn" data-act="resume-member" data-id="${esc(id)}">Resume</button>` : ""}
          ${m.status !== "cancelled" ? `<button type="button" class="btn danger" data-act="cancel-member" data-id="${esc(id)}">Cancel membership</button>` : `<button type="button" class="btn" data-act="reactivate-member" data-id="${esc(id)}">Re-join</button>`}
        </div>
        <h4 class="section-title">Payment history</h4>
        ${pays.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Receipt</th><th>Type</th><th>For</th><th>Method</th><th class="num">Amount</th><th></th></tr></thead><tbody>
          ${pays.map(p => `<tr><td>${fmtDate(p.date)}</td><td>${esc(p.receipt || "")}</td><td>${esc(p.type || "Membership")}</td><td>${(p.type || "Membership") === "Membership" ? periodLabel(p.forMonth, p.months) : esc(p.note || "")}</td><td>${esc(p.method || "")}</td><td class="num">${money(p.amount)}</td><td class="actions"><button type="button" class="btn small" data-act="receipt" data-id="${esc(p.id)}">Receipt</button></td></tr>`).join("")}
          </tbody><tfoot><tr><td colspan="5">Total paid</td><td class="num">${money(sum(pays, p => p.amount))}</td><td></td></tr></tfoot></table></div>` : `<p class="hint">No payments yet.</p>`}
        <footer><button type="button" class="btn danger left" data-act="del-member" data-id="${esc(id)}">Delete member</button><button type="button" class="btn" data-close>Close</button></footer>`;
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
      <div class="full"><label for="c-note">Note</label><input id="c-note" name="cancelNote" maxlength="300" placeholder="Optional: refund, will come back in summer…"></div>
      <div class="full hint">No fees are charged from the cancellation month onward. Their history and payments stay in the log, and you can re-join them later.</div></div>`,
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
      <div class="full"><label for="pa-reason">Reason</label><input id="pa-reason" name="pauseReason" maxlength="200" placeholder="Travel, injury, exams…"></div></div>`,
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
      <div><label for="e-cat">Category</label><select id="e-cat" name="category">${options(EXP_CATS, v.category || "Other")}</select></div>
      <div><label for="e-amount">Amount (${esc(S.settings.currency)}) *</label><input id="e-amount" name="amount" type="number" min="0" step="0.01" required value="${esc(v.amount || "")}"></div>
      <div class="full"><label for="e-desc">Description *</label><input id="e-desc" name="description" required maxlength="200" value="${esc(v.description || "")}" placeholder="e.g. Electricity & water – October"></div>
      <div><label for="e-vendor">Paid to</label><input id="e-vendor" name="vendor" maxlength="120" value="${esc(v.vendor || "")}" placeholder="Landlord, Etihad WE, supplier…"></div>
      <div><label for="e-ref">Invoice / reference no.</label><input id="e-ref" name="ref" maxlength="80" value="${esc(v.ref || "")}"></div>
      <div><label for="e-status">Status</label><select id="e-status" name="status">${options([["paid", "Paid"], ["unpaid", "Not paid yet"]], v.status || "paid")}</select></div>
      <div class="e-paid"><label for="e-method">Method</label><select id="e-method" name="method">${options(METHODS, v.method || "Cash")}</select></div>
      <div class="e-paid"><label for="e-date">Date paid</label><input id="e-date" name="date" type="date" value="${esc(v.date || U.todayISO())}"></div>
      <div class="e-unpaid"><label for="e-due">Due date</label><input id="e-due" name="dueDate" type="date" value="${esc(v.dueDate || "")}"></div>
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
    async onSubmit(d) {
      const unpaid = d.status === "unpaid";
      const data = {
        category: d.category, amount: Number(d.amount) || 0, description: d.description, vendor: d.vendor, ref: d.ref,
        status: d.status, method: unpaid ? "" : d.method, date: unpaid ? (d.dueDate || U.todayISO()) : d.date || U.todayISO(),
        dueDate: unpaid ? d.dueDate : (x?.dueDate || ""), notes: d.notes
      };
      if (x) {
        await store.update("expenses", x.id, data);
        await log(`Edited expense: ${data.description} ${money(data.amount)} (${unpaid ? "unpaid" : "paid"})`);
      } else {
        Object.assign(data, { billId: pre.billId || "", period: pre.period || "", createdAt: U.nowISO(), createdBy: who() });
        await store.add("expenses", data);
        await log(`${pre.billId ? "Entered bill" : "Added expense"}: ${data.description} ${money(data.amount)} – ${data.category} (${unpaid ? "not paid yet" : "paid by " + data.method})`);
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
      <div><label for="pe-method">Method</label><select id="pe-method" name="method">${options(METHODS, "Bank transfer")}</select></div>
      <div><label for="pe-date">Date paid</label><input id="pe-date" name="date" type="date" value="${U.todayISO()}" required></div>
      <div><label for="pe-ref">Reference</label><input id="pe-ref" name="ref" maxlength="80" value="${esc(x.ref || "")}"></div></div>`,
    async onSubmit(d) {
      await store.update("expenses", id, { status: "paid", amount: Number(d.amount) || 0, method: d.method, date: d.date, ref: d.ref, dueDate: x.dueDate || "" });
      await log(`Paid bill: ${x.description || x.category} ${money(d.amount)} (${d.method})`);
      U.toast("Marked as paid");
    }
  });
}

function openEquipment(id) {
  const e = id ? S.equipment.find(x => x.id === id) : {};
  modal({
    title: id ? `Edit ${e.name}` : "Add equipment", submitLabel: id ? "Save" : "Add",
    body: `<div class="fgrid">
      <div class="full"><label for="q-name">Item *</label><input id="q-name" name="name" required maxlength="120" value="${esc(e.name || "")}" placeholder="e.g. Boxing gloves 12oz"></div>
      <div><label for="q-cat">Category</label><select id="q-cat" name="category">${options(EQ_CATS, e.category || "Other")}</select></div>
      <div><label for="q-qty">Quantity</label><input id="q-qty" name="qty" type="number" min="0" step="1" value="${esc(e.qty ?? 1)}"></div>
      <div><label for="q-cond">Condition</label><select id="q-cond" name="condition">${options(EQ_COND, e.condition || "New")}</select></div>
      <div><label for="q-cost">Unit cost (${esc(S.settings.currency)})</label><input id="q-cost" name="unitCost" type="number" min="0" step="0.01" value="${esc(e.unitCost ?? "")}"></div>
      <div><label for="q-date">Purchase date</label><input id="q-date" name="purchaseDate" type="date" value="${esc(e.purchaseDate || U.todayISO())}"></div>
      <div><label for="q-sup">Supplier</label><input id="q-sup" name="supplier" maxlength="120" value="${esc(e.supplier || "")}"></div>
      <div><label for="q-loc">Location</label><input id="q-loc" name="location" maxlength="80" value="${esc(e.location || "")}" placeholder="Main hall, storage…"></div>
      <div><label for="q-svc">Next service / check</label><input id="q-svc" name="serviceDue" type="date" value="${esc(e.serviceDue || "")}"></div>
      <div class="full"><label for="q-notes">Notes</label><input id="q-notes" name="notes" maxlength="300" value="${esc(e.notes || "")}"></div>
      ${id ? "" : `<div class="full"><label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="asExpense" checked> Also log the purchase as a paid expense</label></div>
      <div><label for="q-method">Paid by</label><select id="q-method" name="method">${options(METHODS, "Cash")}</select></div>`}</div>`,
    footer: `<footer>${id ? `<button type="button" class="btn danger left" data-act="del-eq" data-id="${esc(id)}">Delete</button>` : ""}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${id ? "Save" : "Add"}</button></footer>`,
    async onSubmit(d) {
      const data = { name: d.name, category: d.category, qty: Number(d.qty) || 0, condition: d.condition, unitCost: Number(d.unitCost) || 0, purchaseDate: d.purchaseDate, supplier: d.supplier, location: d.location, serviceDue: d.serviceDue, notes: d.notes };
      if (id) {
        await store.update("equipment", id, data);
        await log(`Edited equipment: ${data.name}${e.condition !== data.condition ? ` (${e.condition} → ${data.condition})` : ""}`);
      } else {
        await store.add("equipment", { ...data, createdAt: U.nowISO(), createdBy: who() });
        await log(`Added equipment: ${data.qty}× ${data.name}`);
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

function openLead(id, pre = {}) {
  const l = id ? S.leads.find(x => x.id === id) : pre;
  modal({
    title: id ? `Trial request: ${l.name}` : "Add trial request", submitLabel: id ? "Save" : "Add",
    body: `<div class="fgrid">
      <div><label for="ld-name">Name *</label><input id="ld-name" name="name" required maxlength="100" value="${esc(l.name || "")}"></div>
      <div><label for="ld-phone">Phone *</label><input id="ld-phone" name="phone" required maxlength="30" value="${esc(l.phone || "")}"></div>
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
  await store.add("attendance", { memberId, memberName: m.name, program: (m.programs || [])[0] || "", date: today, time: U.nowTime(), by: who() });
  await log(`Checked in ${m.name}`);
  const st = statusFor(m);
  U.toast(st.state === "overdue" || st.state === "partial" ? `${m.name} checked in. Note: ${money(st.balance)} unpaid` : `${m.name} checked in`, st.state === "overdue" ? "error" : "");
}

function openCheckin() {
  let q = "";
  const listHtml = () => {
    const today = U.todayISO();
    const inToday = new Map(S.attendance.filter(a => a.date === today).map(a => [a.memberId, a.time]));
    const ms = S.members.filter(m => (m.status || "active") === "active")
      .filter(m => !q || (m.name || "").toLowerCase().includes(q) || (m.phone || "").includes(q)).sort(byName).slice(0, 60);
    return ms.length ? `<ul class="list">${ms.map(m => {
      const st = statusFor(m);
      return `<li><div class="grow"><b>${esc(m.name)}</b><span class="sub">${esc((m.programs || []).join(", "))}${["overdue", "partial"].includes(st.state) ? ` · <span style="color:var(--bad)">${money(st.balance)} unpaid</span>` : ""}</span></div>
        ${inToday.has(m.id) ? badge("b-ok", "✓ " + inToday.get(m.id)) : `<button type="button" class="btn small primary" data-ci="${esc(m.id)}">Check in</button>`}</li>`;
    }).join("")}</ul>` : `<p class="hint">No active members match.</p>`;
  };
  modal({
    title: "Check members in",
    body: `<input type="search" id="ci-q" placeholder="Type a name or phone…" autocomplete="off" autofocus><div id="ci-list" style="margin-top:10px;max-height:55vh;overflow:auto">${listHtml()}</div>`,
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
  const forText = (p.type || "Membership") === "Membership" ? `Membership, ${periodLabel(p.forMonth, p.months)}` : `${p.type}${p.note ? " – " + p.note : ""}`;
  const text = `Receipt ${p.receipt} – ${S.settings.clubName}\nReceived from: ${p.memberName || p.payerName}\nAmount: ${money(p.amount)}\nFor: ${forText}\nMethod: ${p.method}\nDate: ${fmtDate(p.date)}\nThank you!`;
  const wa = m ? U.waLink(m.guardianPhone || m.phone, text) : "";
  modal({
    title: `Receipt ${p.receipt}`,
    body: `<div class="receipt">
      <div class="r-head"><div><img src="../images/logo.png" alt="${esc(S.settings.clubName)}"><div class="hint" style="margin-top:6px">Lavender Tower, P6-610, Emirates City, Ajman<br>+971 56 261 3563</div></div>
        <div style="text-align:right"><b style="font-size:18px">RECEIPT</b><br>${esc(p.receipt)}<br>${fmtDate(p.date)}</div></div>
      <table><tr><td>Received from</td><td>${esc(p.memberName || p.payerName)}</td></tr>
        <tr><td>For</td><td>${esc(forText)}</td></tr>
        <tr><td>Payment method</td><td>${esc(p.method)}</td></tr>
        <tr class="total"><td>Amount</td><td>${money(p.amount)}</td></tr></table>
      <p class="hint" style="margin-top:14px">Recorded by ${esc(p.createdBy || "")}. Thank you for training with us!</p></div>`,
    footer: `<footer>${wa ? `<a class="btn wa left" href="${esc(wa)}" target="_blank" rel="noopener">Send on WhatsApp</a>` : ""}<button type="button" class="btn" data-close>Close</button><button type="button" class="btn primary" data-act="print">Print</button></footer>`
  });
}

// ---------- CSV import / export ----------
const MEMBER_COLS = [["Name", "name"], ["Phone", "phone"], ["Email", "email"], ["Date of birth", "dob"], ["Guardian name", "guardianName"], ["Guardian phone", "guardianPhone"], ["Programs", m => (m.programs || []).join("; ")], ["Plan", "plan"], ["Fee", "fee"], ["Billing cycle (months)", "cycle"], ["Start date", "startDate"], ["Status", m => m.status || "active"], ["Belt / rank", "belt"], ["Cancelled on", "cancelDate"], ["Cancel reason", "cancelReason"], ["Owes now", m => outstanding(m).total || ""], ["Notes", "notes"]];

function exportData(kind) {
  const stamp = U.todayISO();
  const files = {
    members: () => [`members-${stamp}.csv`, U.toCSV([...S.members].sort(byName), MEMBER_COLS)],
    payments: () => [`payments-${stamp}.csv`, U.toCSV([...S.payments].sort((a, b) => (a.date || "").localeCompare(b.date || "")), PAY_COLS)],
    "payments-month": () => [`payments-${S.ui.payMonth}.csv`, U.toCSV(S.payments.filter(p => (p.date || "").startsWith(S.ui.payMonth)).sort((a, b) => (a.date || "").localeCompare(b.date || "")), PAY_COLS)],
    expenses: () => [`expenses-${stamp}.csv`, U.toCSV([...S.expenses].sort((a, b) => (a.date || "").localeCompare(b.date || "")), [["Date", "date"], ["Category", "category"], ["Description", "description"], ["Paid to", "vendor"], ["Amount", "amount"], ["Status", "status"], ["Method", "method"], ["Due date", "dueDate"], ["Reference", "ref"], ["Notes", "notes"], ["Recorded by", "createdBy"]])],
    equipment: () => [`equipment-${stamp}.csv`, U.toCSV(S.equipment, [["Item", "name"], ["Category", "category"], ["Quantity", "qty"], ["Condition", "condition"], ["Unit cost", "unitCost"], ["Purchase date", "purchaseDate"], ["Supplier", "supplier"], ["Location", "location"], ["Next service", "serviceDue"], ["Notes", "notes"]])],
    leads: () => [`trial-requests-${stamp}.csv`, U.toCSV(S.leads, [["Received", r => (r.createdAt || "").slice(0, 10)], ["Name", "name"], ["Phone", "phone"], ["Program", "program"], ["Who", "ageGroup"], ["Best time", "preferredTime"], ["Source", "source"], ["Status", "status"], ["Trial date", "trialDate"], ["Message", "message"]])],
    attendance: () => [`attendance-${stamp}.csv`, U.toCSV([...S.attendance].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)), [["Date", "date"], ["Time", "time"], ["Member", "memberName"], ["Class", "program"], ["Checked in by", "by"]])],
    year: () => {
      const y = S.ui.repYear;
      const rows = Array.from({ length: 12 }, (_, i) => `${y}-${U.pad(i + 1)}`).map(m => {
        const ps = S.payments.filter(p => (p.date || "").startsWith(m));
        const mem = sum(ps.filter(p => (p.type || "Membership") === "Membership"), p => p.amount);
        const inc = sum(ps, p => p.amount), exp = spentIn(m);
        return { m: fmtMonth(m), mem, other: inc - mem, inc, exp, net: inc - exp, joined: S.members.filter(x => (x.startDate || "").startsWith(m)).length, cancelled: S.members.filter(x => x.status === "cancelled" && (x.cancelDate || "").startsWith(m)).length };
      });
      return [`summary-${y}.csv`, U.toCSV(rows, [["Month", "m"], ["Membership income", "mem"], ["Other income", "other"], ["Total income", "inc"], ["Expenses", "exp"], ["Net", "net"], ["New members", "joined"], ["Cancellations", "cancelled"]])];
    }
  };
  const [name, csv] = files[kind]();
  U.download(name, csv);
}
const PAY_COLS = [["Date", "date"], ["Receipt", "receipt"], ["Member / payer", p => p.memberName || p.payerName], ["Type", p => p.type || "Membership"], ["For month", "forMonth"], ["Months", "months"], ["Amount", "amount"], ["Method", "method"], ["Note", "note"], ["Recorded by", "createdBy"]];

const ALIASES = {
  name: ["name", "fullname", "membername", "student", "studentname", "member", "clientname", "client"],
  phone: ["phone", "mobile", "mobileno", "mobilenumber", "phonenumber", "phoneno", "whatsapp", "contact", "contactnumber", "contactno", "tel"],
  email: ["email", "emailaddress", "mail"],
  dob: ["dateofbirth", "dob", "birthdate", "birthday"],
  guardianName: ["guardian", "guardianname", "parent", "parentname", "father", "fathername", "mother", "mothername"],
  guardianPhone: ["guardianphone", "parentphone", "parentmobile", "parentcontact", "fatherphone", "motherphone"],
  programs: ["programs", "program", "class", "classes", "sport", "training", "course", "activity"],
  plan: ["plan", "package", "membership", "membershiptype"],
  fee: ["fee", "fees", "amount", "price", "monthlyfee", "feeaed", "feesaed", "aed"],
  cycle: ["billingcyclemonths", "cycle", "billingcycle", "months", "duration", "billing"],
  startDate: ["startdate", "joindate", "joined", "datejoined", "joiningdate", "start", "admissiondate", "date"],
  status: ["status", "state", "active"],
  belt: ["beltrank", "belt", "rank", "grade", "level"],
  notes: ["notes", "note", "remarks", "comments", "comment"]
};

function rowsToMembers(table) {
  const head = table[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const idx = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const i = head.findIndex(h => names.includes(h));
    if (i >= 0) idx[key] = i;
  }
  if (idx.name === undefined) throw new Error("Couldn't find a Name column. The first row must hold column titles like Name, Phone, Program, Fee.");
  const get = (r, k) => (idx[k] === undefined ? "" : String(r[idx[k]] ?? "").trim());
  return table.slice(1).map(r => {
    const progs = get(r, "programs").split(/[;,/|]+/).map(s => s.trim()).filter(Boolean)
      .map(s => PROGRAMS.find(p => p.toLowerCase() === s.toLowerCase()) || s);
    const cyc = get(r, "cycle").toLowerCase();
    const st = get(r, "status").toLowerCase();
    return {
      name: get(r, "name"), phone: get(r, "phone"), email: get(r, "email"), dob: U.parseDate(get(r, "dob")),
      guardianName: get(r, "guardianName"), guardianPhone: get(r, "guardianPhone"), programs: progs, plan: get(r, "plan"),
      fee: Number(get(r, "fee").replace(/[^0-9.]/g, "")) || 0,
      cycle: /12|year|annual/.test(cyc) ? 12 : /6|half|semi/.test(cyc) ? 6 : /3|quarter/.test(cyc) ? 3 : 1,
      startDate: U.parseDate(get(r, "startDate")) || U.todayISO(),
      status: /cancel|left|stop|inactive|no/.test(st) ? "cancelled" : /pause|freeze|hold/.test(st) ? "paused" : "active",
      belt: get(r, "belt"), notes: get(r, "notes")
    };
  }).filter(m => m.name);
}

function openImportMembers() {
  let parsed = [];
  modal({
    title: "Import members from Excel (CSV)", submitLabel: "Import",
    body: `<p class="hint" style="margin-top:0">In Excel: File → Save As → <b>CSV UTF-8</b>. The first row should be the column titles. Recognised columns: Name, Phone, Email, Date of birth, Guardian name, Guardian phone, Programs, Plan, Fee, Billing cycle (months), Start date, Status, Belt / rank, Notes.</p>
      <input type="file" id="imp-file" accept=".csv,text/csv">
      <label style="display:flex;gap:8px;align-items:center;margin-top:10px;color:var(--text)"><input type="checkbox" name="skipDupes" checked> Skip people already in the list (same name and phone)</label>
      <label style="display:flex;gap:8px;align-items:center;margin-top:6px;color:var(--text)"><input type="checkbox" name="settledBefore" checked> Count months before ${fmtMonth(U.thisMonth())} as already paid</label>
      <span class="hint">Untick only if you will also enter their past payments.</span>
      <div id="imp-preview" style="margin-top:12px"></div>`,
    onOpen(el) {
      el.querySelector("#imp-file").addEventListener("change", async e => {
        const file = e.target.files[0];
        const out = el.querySelector("#imp-preview");
        if (!file) return;
        try {
          parsed = rowsToMembers(U.parseCSV(await file.text()));
          out.innerHTML = parsed.length ? `<div class="callout ok">Found ${parsed.length} members. First rows:</div><div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Phone</th><th>Programs</th><th class="num">Fee</th><th>Start</th><th>Status</th></tr></thead><tbody>
            ${parsed.slice(0, 6).map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.phone)}</td><td>${esc(m.programs.join(", "))}</td><td class="num">${money(m.fee)}</td><td>${fmtDate(m.startDate)}</td><td>${esc(m.status)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="callout warn">No rows with a name were found.</div>`;
        } catch (err) {
          parsed = [];
          out.innerHTML = `<div class="callout bad">${esc(err.message)}</div>`;
        }
      });
    },
    async onSubmit(d) {
      if (!parsed.length) { U.toast("Choose a CSV file first.", "error"); return false; }
      const key = m => `${(m.name || "").toLowerCase().trim()}|${String(m.phone || "").replace(/\D/g, "")}`;
      const existing = new Set(S.members.map(key));
      const rows = (d.skipDupes ? parsed.filter(m => !existing.has(key(m))) : parsed)
        .map(m => ({ ...m, billingFrom: d.settledBefore ? U.thisMonth() : "", createdAt: U.nowISO(), createdBy: who(), ...(m.status === "cancelled" ? { cancelDate: U.todayISO(), cancelReason: "Imported as cancelled" } : {}), ...(m.status === "paused" ? { pausedFrom: U.todayISO() } : {}) }));
      if (!rows.length) { U.toast("Everyone in that file is already in the list."); return; }
      await store.addMany("members", rows);
      await log(`Imported ${rows.length} members from ${parsed.length > rows.length ? `CSV (${parsed.length - rows.length} duplicates skipped)` : "CSV"}`);
      U.toast(`Imported ${rows.length} members`);
    }
  });
}

async function backup() {
  const data = await store.exportAll();
  U.download(`wariors-backup-${U.todayISO()}.json`, JSON.stringify(data, null, 1), "application/json");
  await log("Downloaded a full backup");
}

function openRestore() {
  let data = null;
  modal({
    title: "Restore from backup", submitLabel: "Restore",
    body: `<p class="hint" style="margin-top:0">Choose a backup file downloaded from this dashboard. Records in the backup are written back (same records are overwritten, newer ones are kept).</p><input type="file" id="rs-file" accept=".json,application/json"><div id="rs-info" style="margin-top:10px"></div>`,
    onOpen(el) {
      el.querySelector("#rs-file").addEventListener("change", async e => {
        const info = el.querySelector("#rs-info");
        try {
          data = JSON.parse(await e.target.files[0].text());
          info.innerHTML = `<div class="callout info">Backup from ${U.fmtWhen(data.exportedAt)}: ${COLLECTIONS.map(c => `${(data[c] || []).length} ${c}`).join(", ")}.</div>`;
        } catch {
          data = null;
          info.innerHTML = `<div class="callout bad">That file isn't a valid backup.</div>`;
        }
      });
    },
    async onSubmit() {
      if (!data) { U.toast("Choose a backup file first.", "error"); return false; }
      let n = 0;
      for (const c of COLLECTIONS) if (Array.isArray(data[c]) && data[c].length) n += await store.addMany(c, data[c]);
      const st = (data.settings || []).find(s => s.id === "main");
      if (st) { const { id, ...rest } = st; await store.set("settings", "main", rest); }
      await log(`Restored ${n} records from a backup of ${U.fmtWhen(data.exportedAt)}`);
      U.toast(`Restored ${n} records`);
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
  d.graceDays = Number(d.graceDays) || 0;
  d.plans = (d.plans || []).filter(p => p.name.trim()).map(p => ({ name: p.name.trim(), fee: Number(p.fee) || 0, cycle: Number(p.cycle) || 1 }));
  d.bills = (d.bills || []).filter(b => b.name.trim()).map(b => ({ id: b.id, name: b.name.trim(), category: b.category, amount: Number(b.amount) || 0, dueDay: Math.min(31, Math.max(1, Number(b.dueDay) || 1)), startMonth: b.startMonth || U.thisMonth() }));
  delete d.id;
  await store.set("settings", "main", d);
  S.settings = { ...DEFAULT_SETTINGS, ...d };
  S.ui.draft = structuredClone(S.settings);
  await log("Updated settings");
  U.toast("Settings saved");
  render();
}

// ---------- Demo data ----------
async function seedDemo() {
  store.demoClear();
  const t = U.todayISO(), ym = U.thisMonth();
  const mAgo = (n, day = 5) => `${U.addMonths(ym, -n)}-${U.pad(day)}`;
  const people = [
    ["Ahmed Al Mansoori", "050 000 0101", ["Karate"], 350, 1, mAgo(8, 3), { belt: "Green belt" }],
    ["Priya Nair", "", ["Kalaripayattu"], 300, 1, mAgo(5, 10), { guardianName: "Anand Nair", guardianPhone: "050 000 0102", dob: "2015-04-12" }],
    ["Omar Haddad", "050 000 0103", ["MMA", "Boxing"], 950, 3, mAgo(4, 1)],
    ["Fatima Zahra", "050 000 0104", ["Yoga"], 250, 1, mAgo(3, 7)],
    ["Rahul Menon", "050 000 0105", ["Muay Thai"], 350, 1, mAgo(6, 2)],
    ["Sara Ibrahim", "050 000 0106", ["Zumba"], 200, 1, mAgo(2, 4)],
    ["Yousef Khalil", "", ["Karate"], 300, 1, mAgo(10, 6), { guardianName: "Khalil Saeed", guardianPhone: "050 000 0107", dob: "2013-09-30", belt: "Orange belt" }],
    ["Daniel Costa", "050 000 0108", ["Kickboxing"], 350, 1, mAgo(0, 1)],
    ["Aisha Rahman", "050 000 0109", ["Fitness", "EMS"], 450, 1, mAgo(7, 9)],
    ["Mohammed Tariq", "050 000 0110", ["Boxing"], 350, 1, mAgo(9, 5), { status: "cancelled", cancelDate: mAgo(1, 20), cancelReason: "Schedule doesn't fit" }],
    ["Leila Hassan", "050 000 0111", ["Aerobics"], 200, 1, mAgo(5, 3), { status: "paused", pausedFrom: `${ym}-01`, pauseUntil: U.addDays(t, 20), pauseReason: "Travelling" }],
    ["Arjun Pillai", "", ["Gymnastics Floor"], 300, 1, mAgo(4, 2), { guardianName: "Vinod Pillai", guardianPhone: "050 000 0112", dob: "2016-01-22" }],
    ["Hamza Qureshi", "050 000 0113", ["CrossFit"], 400, 1, mAgo(5, 8), { status: "cancelled", cancelDate: mAgo(2, 15), cancelReason: "Moved away" }],
    ["Noor Saleh", "050 000 0114", ["Personal Training"], 1200, 1, mAgo(2, 3)]
  ];
  const members = people.map(([name, phone, programs, fee, cycle, startDate, extra = {}], i) => ({
    id: `demo-m${i + 1}`, name, phone, programs, fee, cycle, startDate, status: "active", plan: cycle === 3 ? "MMA quarterly" : "", createdAt: U.nowISO(), createdBy: "demo@local", ...extra
  }));
  const methods = ["Cash", "Card", "Bank transfer", "Cash", "Card"];
  const payments = [];
  let r = 0;
  const pay = (m, forMonth, months, amount, date, type = "Membership", note = "") =>
    payments.push({ id: `demo-p${++r}`, memberId: m.id, memberName: m.name, type, amount, method: methods[r % methods.length], date, forMonth, months, note, receipt: `R-${String(r).padStart(4, "0")}`, createdAt: U.nowISO(), createdBy: "demo@local" });
  const unpaidNow = new Set(["Rahul Menon", "Daniel Costa", "Arjun Pillai"]);
  for (const m of members) {
    const c = m.cycle, s = m.startDate.slice(0, 7);
    for (let p = s; p <= ym; p = U.addMonths(p, c)) {
      const isNow = U.monthDiff(p, ym) < c;
      if (m.status === "cancelled" && p >= m.cancelDate.slice(0, 7)) break;
      if (m.status === "paused" && p >= m.pausedFrom.slice(0, 7)) break;
      if (isNow && unpaidNow.has(m.name)) continue;
      if (m.name === "Arjun Pillai" && U.monthDiff(p, ym) === 1) continue;
      const day = U.pad(Math.min(28, Number(m.startDate.slice(8)) + (r % 4)));
      const date = `${p}-${day}` > t ? t : `${p}-${day}`;
      if (isNow && m.name === "Sara Ibrahim") { pay(m, p, c, 100, date); continue; }
      pay(m, p, c, m.fee, date);
    }
  }
  pay(members[7], "", 0, 100, members[7].startDate, "Registration fee");
  pay(members[6], "", 0, 150, mAgo(1, 18), "Grading / belt test", "Orange belt grading");
  pay(members[5], "", 0, 120, mAgo(1, 12), "Uniform & gear sale", "Gloves");
  payments.push({ id: "demo-p-walkin", memberId: "", memberName: "", payerName: "Walk-in drop-in", type: "Other income", amount: 60, method: "Cash", date: t, note: "Single class", receipt: `R-${String(++r).padStart(4, "0")}`, createdAt: U.nowISO(), createdBy: "demo@local" });

  const bills = [
    { id: "bill-rent", name: "Rent", category: "Rent", amount: 6500, dueDay: 1, startMonth: U.addMonths(ym, -4) },
    { id: "bill-ewe", name: "Electricity & water (Etihad WE)", category: "Utilities (electricity & water)", amount: 0, dueDay: 12, startMonth: U.addMonths(ym, -4) },
    { id: "bill-net", name: "Internet & phone", category: "Internet & phone", amount: 389, dueDay: 15, startMonth: U.addMonths(ym, -4) },
    { id: "bill-coach", name: "Coach salaries", category: "Salaries & coach fees", amount: 9000, dueDay: 28, startMonth: U.addMonths(ym, -4) }
  ];
  const expenses = [];
  let e = 0;
  const ex = (o) => expenses.push({ id: `demo-e${++e}`, status: "paid", method: "Bank transfer", createdAt: U.nowISO(), createdBy: "demo@local", ...o });
  for (let k = 4; k >= 1; k--) {
    const p = U.addMonths(ym, -k);
    ex({ billId: "bill-rent", period: p, category: "Rent", description: `Rent – ${fmtMonth(p)}`, vendor: "Landlord", amount: 6500, date: `${p}-01` });
    ex({ billId: "bill-ewe", period: p, category: "Utilities (electricity & water)", description: `Electricity & water – ${fmtMonth(p)}`, vendor: "Etihad WE", amount: [910, 1040, 980, 1120][k - 1], date: `${p}-12` });
    ex({ billId: "bill-net", period: p, category: "Internet & phone", description: `Internet – ${fmtMonth(p)}`, vendor: "e&", amount: 389, date: `${p}-15` });
    ex({ billId: "bill-coach", period: p, category: "Salaries & coach fees", description: `Coach salaries – ${fmtMonth(p)}`, vendor: "Staff", amount: 9000, date: `${p}-28` });
  }
  ex({ billId: "bill-rent", period: ym, category: "Rent", description: `Rent – ${fmtMonth(ym)}`, vendor: "Landlord", amount: 6500, date: `${ym}-01` });
  ex({ billId: "bill-ewe", period: ym, category: "Utilities (electricity & water)", description: `Electricity & water – ${fmtMonth(ym)}`, vendor: "Etihad WE", amount: 1065, status: "unpaid", method: "", date: `${ym}-12`, dueDate: `${ym}-12` });
  ex({ category: "Equipment purchase", description: "10× Boxing gloves 12oz", vendor: "Sports Corner", amount: 1500, method: "Card", date: mAgo(2, 6) });
  ex({ category: "Equipment purchase", description: "2× Heavy bags", vendor: "Sports Corner", amount: 1400, method: "Card", date: mAgo(1, 9) });
  ex({ category: "Equipment repair & service", description: "Repair: EMS suit cable", vendor: "EMS Tech", amount: 350, method: "Cash", date: mAgo(1, 21) });
  ex({ category: "Marketing & ads", description: "Instagram ads", vendor: "Meta", amount: 300, method: "Card", date: mAgo(0, 3) > t ? t : mAgo(0, 3) });
  ex({ category: "Cleaning & supplies", description: "Mat cleaner and towels", vendor: "Supermarket", amount: 180, status: "unpaid", method: "", date: U.addDays(t, 5), dueDate: U.addDays(t, 5) });

  const equipment = [
    ["Boxing gloves 12oz", "Gloves & wraps", 10, "Good", 150, mAgo(2, 6), "Sports Corner"],
    ["Heavy bags", "Bags", 2, "New", 700, mAgo(1, 9), "Sports Corner"],
    ["Puzzle mats 1m×1m", "Mats & flooring", 40, "Good", 85, mAgo(10, 1), "Mat Supplier"],
    ["Thai pads", "Pads & shields", 8, "Worn", 120, mAgo(9, 1), "Sports Corner"],
    ["EMS suits", "EMS equipment", 4, "Needs repair", 2500, mAgo(8, 1), "EMS Tech", U.addDays(t, 7)],
    ["Kettlebell set", "Weights & strength", 1, "Good", 900, mAgo(7, 1), "Fitness Store"],
    ["Yoga mats", "Yoga & mobility", 15, "Good", 60, mAgo(6, 1), "Fitness Store"],
    ["Karate belts (for sale)", "Uniforms & belts (stock)", 30, "New", 15, mAgo(3, 1), "Martial Supply"]
  ].map(([name, category, qty, condition, unitCost, purchaseDate, supplier, serviceDue = ""], i) => ({ id: `demo-q${i + 1}`, name, category, qty, condition, unitCost, purchaseDate, supplier, serviceDue, location: "Main hall", createdAt: U.nowISO() }));

  const leads = [
    ["Khalid Mahmoud", "050 000 0201", "Kickboxing", "Adult (18+)", "Evening", "Website", "New", -1],
    ["Meera Das", "050 000 0202", "Yoga", "Adult (18+)", "Morning", "Website", "New", 0, "Is there a ladies-only class?"],
    ["Hassan Ali", "050 000 0203", "Karate", "Child (under 13)", "Evening", "Website", "Contacted", -3, "For my son, 8 years old"],
    ["Julia Novak", "050 000 0204", "Muay Thai", "Adult (18+)", "Weekend", "Instagram", "Trial booked", -4, "", U.addDays(t, 2)],
    ["Saif Al Nuaimi", "050 000 0205", "MMA", "Adult (18+)", "Evening", "Walk-in", "Not interested", -20]
  ].map(([name, phone, program, ageGroup, preferredTime, source, status, days, message = "", trialDate = ""], i) => ({ id: `demo-l${i + 1}`, name, phone, program, ageGroup, preferredTime, source, status, message, trialDate, createdAt: new Date(Date.now() + days * 864e5).toISOString() }));

  const attendance = [];
  let a = 0;
  members.filter(m => m.status === "active").forEach((m, i) => {
    for (let d = 1; d <= 30; d++) {
      if (m.name === "Rahul Menon" && d < 18) continue;
      if ((d + i) % 3 !== 0) continue;
      const date = U.addDays(t, -d);
      if (date < m.startDate) continue;
      attendance.push({ id: `demo-a${++a}`, memberId: m.id, memberName: m.name, program: m.programs[0], date, time: `${17 + (i % 4)}:${U.pad((i * 7) % 60)}`, by: "demo@local" });
    }
  });

  const settings = { ...DEFAULT_SETTINGS, plans: [{ name: "Martial arts – monthly", fee: 350, cycle: 1 }, { name: "Kids martial arts – monthly", fee: 300, cycle: 1 }, { name: "MMA quarterly", fee: 950, cycle: 3 }, { name: "Yoga / Zumba / Aerobics – monthly", fee: 250, cycle: 1 }, { name: "Personal training – monthly", fee: 1200, cycle: 1 }], bills };

  await store.addMany("members", members);
  await store.addMany("payments", payments);
  await store.addMany("expenses", expenses);
  await store.addMany("equipment", equipment);
  await store.addMany("leads", leads);
  await store.addMany("attendance", attendance);
  await store.set("settings", "main", settings);
  await store.add("activity", { at: U.nowISO(), by: "demo@local", text: "Loaded sample data (made-up members and prices, for trying the dashboard)" });
}

// ---------- Event wiring ----------
const ACTIONS = {
  ui(arg) { const [k, v] = arg.split("="); S.ui[k] = v; render(); },
  member: id => memberDetail(id),
  "new-member": () => openNewMember(),
  "edit-member": id => openEditMember(id),
  "new-payment": () => openPayment(),
  "pay-member": (id, el) => openPayment({ memberId: id, forMonth: el.dataset.month }),
  async remind(id, el) {
    const m = memberById(id);
    if (!m) return;
    await store.update("members", id, { lastReminderAt: U.nowISO() });
    await log(`Sent WhatsApp payment reminder to ${m.name} (${money(el.dataset.amount)}, ${fmtMonth(el.dataset.period)})`);
  },
  receipt: id => openReceipt(id),
  print() { document.body.classList.add("printing"); window.print(); setTimeout(() => document.body.classList.remove("printing"), 300); },
  async "del-payment"(id) {
    const p = S.payments.find(x => x.id === id);
    if (!(await U.confirmBox(`Delete payment ${esc(p.receipt)} (${money(p.amount)} from ${esc(p.memberName || p.payerName)})? This can't be undone, but it will stay in the activity log.`, { danger: true, okLabel: "Delete payment" }))) return;
    await store.remove("payments", id);
    await log(`Deleted payment ${p.receipt}: ${money(p.amount)} from ${p.memberName || p.payerName} (${p.date})`);
  },
  "cancel-member": id => openCancel(id),
  "pause-member": id => openPause(id),
  async "resume-member"(id) {
    const m = memberById(id);
    await store.update("members", id, { status: "active", pausedFrom: "", pauseUntil: "", pauseReason: "" });
    await log(`Resumed membership: ${m.name}`);
    U.toast(`${m.name} is active again`);
  },
  async "reactivate-member"(id) {
    const m = memberById(id);
    if (!(await U.confirmBox(`Re-join ${esc(m.name)}? Billing starts again from today.`, { okLabel: "Re-join" }))) return;
    await store.update("members", id, { status: "active", startDate: U.todayISO(), rejoinedFrom: m.cancelDate || "", cancelDate: "", cancelReason: "", cancelNote: "" });
    await log(`Re-joined ${m.name} (had cancelled ${fmtDate(m.cancelDate)})`);
    openPayment({ memberId: id });
  },
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
  "new-expense": () => openExpense(),
  "edit-expense": id => openExpense({ id }),
  "pay-expense": id => openPayExpense(id),
  "pay-bill"(id, el) {
    const b = (S.settings.bills || []).find(x => x.id === id);
    const p = el.dataset.month || U.thisMonth();
    openExpense({ billId: b.id, period: p, category: b.category, description: `${b.name} – ${fmtMonth(p)}`, amount: b.amount || "", date: U.todayISO(), dueDate: `${p}-${U.pad(Math.min(Number(b.dueDay) || 1, U.daysInMonth(p)))}` });
  },
  async "del-expense"(id) {
    const x = S.expenses.find(e => e.id === id);
    if (!(await U.confirmBox(`Delete "${esc(x.description || x.category)}" (${money(x.amount)})?`, { danger: true, okLabel: "Delete" }))) return;
    await store.remove("expenses", id);
    await log(`Deleted expense: ${x.description || x.category} ${money(x.amount)}`);
  },
  "new-eq": () => openEquipment(),
  "edit-eq": id => openEquipment(id),
  "repair-eq"(id) {
    const e = S.equipment.find(x => x.id === id);
    openExpense({ category: "Equipment repair & service", description: `Repair: ${e.name}`, vendor: e.supplier });
  },
  async "del-eq"(id) {
    const e = S.equipment.find(x => x.id === id);
    if (!(await U.confirmBox(`Delete ${esc(e.name)} from the equipment list? (To keep a record, set its condition to Retired instead.)`, { danger: true, okLabel: "Delete" }))) return;
    await store.remove("equipment", id);
    await log(`Deleted equipment: ${e.name}`);
    document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
  },
  "new-lead": () => openLead(null, { source: "Walk-in" }),
  "edit-lead": id => openLead(id),
  "convert-lead"(id) {
    const l = S.leads.find(x => x.id === id);
    const prog = PROGRAMS.includes(l.program) ? [l.program] : [];
    openNewMember({ name: l.name, phone: l.phone, programs: prog, notes: l.message, leadId: id });
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
    U.download("members-template.csv", U.toCSV([{ name: "Example Name", phone: "050 123 4567", programs: ["Karate", "Boxing"], fee: 350, cycle: 1, startDate: U.todayISO(), status: "active" }], MEMBER_COLS.filter(c => !["Owes now", "Cancelled on", "Cancel reason"].includes(c[0]))));
  },
  backup: () => backup(),
  restore: () => openRestore(),
  "save-settings": () => saveSettings(),
  "reset-draft"() { S.ui.draft = null; render(); },
  "add-row"(kind) {
    const d = S.ui.draft;
    if (kind === "plans") (d.plans ||= []).push({ name: "", fee: "", cycle: 1 });
    else (d.bills ||= []).push({ id: "bill-" + Math.random().toString(36).slice(2, 9), name: "", category: "Rent", amount: "", dueDay: 1, startMonth: U.thisMonth() });
    render();
  },
  "del-row"(arg) {
    const [kind, i] = arg.split(".");
    S.ui.draft[kind].splice(Number(i), 1);
    render();
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
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  const external = el.tagName === "A" && el.target === "_blank";
  if (!external) e.preventDefault();
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
    if (el.dataset.change === "eq-cond") {
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

window.addEventListener("hashchange", route);
$("menu").addEventListener("click", () => $("side").classList.toggle("open"));
$("side-scrim").addEventListener("click", () => $("side").classList.remove("open"));
$("sign-out").addEventListener("click", () => store.signOut());

boot();
