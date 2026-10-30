// Data layer for the admin dashboard.
// With a config in firebase-config.js it uses Firebase Auth + Firestore.
// Without one it runs in demo mode and keeps everything in this browser's localStorage.
import { firebaseConfig } from "./firebase-config.js";

export const MODE = firebaseConfig && firebaseConfig.apiKey ? "firebase" : "demo";
const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
export const COLLECTIONS = ["members", "memberships", "payments", "expenses", "equipment", "leads", "handouts", "attendance", "activity", "receipts", "dailyReports", "journal", "monthEnds"];
// Full-size receipt photos, one document per receipt (same id as in "receipts"). Kept out of normal backups because of their size.
export const PHOTOS = "receiptImages";

// ---------- Firebase ----------
let fb = null;

async function loadFirebase({ auth = true, cache = false } = {}) {
  if (fb) return fb;
  const [appMod, fs, au] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-firestore.js`),
    auth ? import(`${SDK}/firebase-auth.js`) : Promise.resolve(null)
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  let db;
  if (cache) {
    try {
      db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
    } catch {
      db = fs.getFirestore(app);
    }
  } else {
    db = fs.getFirestore(app);
  }
  fb = { app, db, fs, au, auth: au ? au.getAuth(app) : null };
  return fb;
}

// Firestore Timestamps become ISO strings so both modes return the same shapes.
function normalize(id, data) {
  const out = { id };
  for (const [k, v] of Object.entries(data)) out[k] = v && typeof v.toDate === "function" ? v.toDate().toISOString() : v;
  return out;
}

// Staff sign in with a plain username; Firebase needs an email, so "wariors" becomes
// "wariors@<project>.firebaseapp.com". A full email address is used as typed.
export function loginEmail(username) {
  const u = String(username || "").trim().toLowerCase();
  return u.includes("@") ? u : `${u}@${firebaseConfig.authDomain}`;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && k !== "id") out[k] = v;
  return out;
}

// ---------- Demo (localStorage) ----------
const LS_KEY = "wma-demo-db-v1";
const LS_USER = "wma-demo-user";
const demoListeners = new Set();

function lsRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function lsWrite(db) {
  localStorage.setItem(LS_KEY, JSON.stringify(db));
  queueMicrotask(() => demoListeners.forEach(fn => fn()));
}
function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 20);
}
function demoRows(col, opts = {}) {
  const db = lsRead();
  let rows = Object.entries(db[col] || {}).map(([id, d]) => ({ id, ...d }));
  if (opts.since) rows = rows.filter(r => (r[opts.since.field] || "") >= opts.since.value);
  if (opts.orderBy) {
    const [f, dir] = opts.orderBy;
    rows.sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === "desc" ? -1 : 1));
  }
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows;
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", e => { if (e.key === LS_KEY) demoListeners.forEach(fn => fn()); });
}

// ---------- Public API ----------
export const store = {
  mode: MODE,

  async init(opts) {
    if (MODE === "firebase") await loadFirebase(opts);
  },

  // Auth
  onAuth(cb) {
    if (MODE === "demo") {
      const read = () => { try { return JSON.parse(sessionStorage.getItem(LS_USER)); } catch { return null; } };
      queueMicrotask(() => cb(read()));
      store._demoAuthCb = cb;
      return () => {};
    }
    return fb.au.onAuthStateChanged(fb.auth, u => cb(u ? { uid: u.uid, email: u.email, name: u.displayName || u.email } : null));
  },
  async signIn(email, password) {
    if (MODE === "demo") {
      const user = { uid: "demo", email: "demo@local", name: "Demo admin" };
      try { sessionStorage.setItem(LS_USER, JSON.stringify(user)); } catch {}
      store._demoAuthCb && store._demoAuthCb(user);
      return user;
    }
    const cred = await fb.au.signInWithEmailAndPassword(fb.auth, loginEmail(email), password);
    return cred.user;
  },
  // For the shared staff login: re-checks the current password, then sets the new one.
  async changePassword(current, next) {
    if (MODE === "demo") throw new Error("There's no password in demo mode.");
    const u = fb.auth.currentUser;
    const cred = fb.au.EmailAuthProvider.credential(u.email, current);
    await fb.au.reauthenticateWithCredential(u, cred);
    await fb.au.updatePassword(u, next);
  },
  async signOut() {
    if (MODE === "demo") {
      try { sessionStorage.removeItem(LS_USER); } catch {}
      store._demoAuthCb && store._demoAuthCb(null);
      return;
    }
    await fb.au.signOut(fb.auth);
  },
  async resetPassword(email) {
    if (MODE === "demo") return;
    await fb.au.sendPasswordResetEmail(fb.auth, email);
  },
  // Staff are whoever the security rules let read the settings; only "permission denied" means no.
  async isAdmin() {
    if (MODE === "demo") return true;
    try {
      await fb.fs.getDocFromServer(fb.fs.doc(fb.db, "settings", "main"));
      return true;
    } catch (e) {
      return e?.code !== "permission-denied";
    }
  },

  // Live lists. opts: { since: {field, value}, orderBy: [field, "asc"|"desc"], limit }
  subscribe(col, cb, opts = {}, onError) {
    if (MODE === "demo") {
      const fn = () => cb(demoRows(col, opts));
      demoListeners.add(fn);
      queueMicrotask(fn);
      return () => demoListeners.delete(fn);
    }
    const { fs, db } = fb;
    const parts = [];
    if (opts.since) parts.push(fs.where(opts.since.field, ">=", opts.since.value));
    if (opts.orderBy) parts.push(fs.orderBy(opts.orderBy[0], opts.orderBy[1] || "asc"));
    if (opts.limit) parts.push(fs.limit(opts.limit));
    const q = fs.query(fs.collection(db, col), ...parts);
    return fs.onSnapshot(q, snap => cb(snap.docs.map(d => normalize(d.id, d.data()))), err => onError && onError(err));
  },
  subscribeDoc(col, id, cb, onError) {
    if (MODE === "demo") {
      const fn = () => { const d = (lsRead()[col] || {})[id]; cb(d ? { id, ...d } : null); };
      demoListeners.add(fn);
      queueMicrotask(fn);
      return () => demoListeners.delete(fn);
    }
    return fb.fs.onSnapshot(fb.fs.doc(fb.db, col, id), s => cb(s.exists() ? normalize(s.id, s.data()) : null), err => onError && onError(err));
  },

  // One document, read once (null if it doesn't exist).
  async get(col, id) {
    if (MODE === "demo") { const d = (lsRead()[col] || {})[id]; return d ? { id, ...d } : null; }
    const s = await fb.fs.getDoc(fb.fs.doc(fb.db, col, id));
    return s.exists() ? normalize(s.id, s.data()) : null;
  },
  // A new document id, for writing two related documents under the same id.
  newId(col) {
    return MODE === "demo" ? newId() : fb.fs.doc(fb.fs.collection(fb.db, col)).id;
  },

  // Writes
  async add(col, data) {
    if (MODE === "demo") {
      const db = lsRead();
      const id = newId();
      (db[col] ||= {})[id] = clean(data);
      lsWrite(db);
      return id;
    }
    const ref = await fb.fs.addDoc(fb.fs.collection(fb.db, col), clean(data));
    return ref.id;
  },
  async set(col, id, data) {
    if (MODE === "demo") {
      const db = lsRead();
      (db[col] ||= {})[id] = clean(data);
      lsWrite(db);
      return;
    }
    await fb.fs.setDoc(fb.fs.doc(fb.db, col, id), clean(data));
  },
  async update(col, id, patch) {
    if (MODE === "demo") {
      const db = lsRead();
      const cur = (db[col] ||= {})[id];
      if (!cur) throw new Error("Record not found");
      db[col][id] = { ...cur, ...clean(patch) };
      lsWrite(db);
      return;
    }
    await fb.fs.updateDoc(fb.fs.doc(fb.db, col, id), clean(patch));
  },
  async remove(col, id) {
    if (MODE === "demo") {
      const db = lsRead();
      if (db[col]) delete db[col][id];
      lsWrite(db);
      return;
    }
    await fb.fs.deleteDoc(fb.fs.doc(fb.db, col, id));
  },
  // Several updates at once, e.g. a new name copied onto a member's payments. ops: [[col, id, patch], …]
  async updateMany(ops) {
    if (!ops.length) return 0;
    if (MODE === "demo") {
      const db = lsRead();
      for (const [col, id, patch] of ops) if (db[col]?.[id]) db[col][id] = { ...db[col][id], ...clean(patch) };
      lsWrite(db);
      return ops.length;
    }
    const { fs, db } = fb;
    for (let i = 0; i < ops.length; i += 400) {
      const batch = fs.writeBatch(db);
      for (const [col, id, patch] of ops.slice(i, i + 400)) batch.update(fs.doc(db, col, id), clean(patch));
      await batch.commit();
    }
    return ops.length;
  },
  // Adds many rows; keeps an "id" field as the document id when present.
  // Photos are big, so they go in small batches (a write request is limited to 10 MB).
  async addMany(col, rows) {
    if (MODE === "demo") {
      const db = lsRead();
      db[col] ||= {};
      for (const r of rows) db[col][r.id || newId()] = clean(r);
      lsWrite(db);
      return rows.length;
    }
    const { fs, db } = fb;
    const size = col === PHOTOS ? 12 : 400;
    for (let i = 0; i < rows.length; i += size) {
      const batch = fs.writeBatch(db);
      for (const r of rows.slice(i, i + size)) {
        const ref = r.id ? fs.doc(db, col, r.id) : fs.doc(fs.collection(db, col));
        batch.set(ref, clean(r));
      }
      await batch.commit();
    }
    return rows.length;
  },
  // Full copy of every collection plus settings, for backups. { photos: true } adds the full-size receipt photos.
  async exportAll({ photos = false } = {}) {
    const out = { exportedAt: new Date().toISOString(), mode: MODE };
    const cols = [...COLLECTIONS, "settings", ...(photos ? [PHOTOS] : [])];
    if (MODE === "demo") {
      const db = lsRead();
      for (const c of cols) out[c] = Object.entries(db[c] || {}).map(([id, d]) => ({ id, ...d }));
      return out;
    }
    for (const c of cols) {
      const snap = await fb.fs.getDocs(fb.fs.collection(fb.db, c));
      out[c] = snap.docs.map(d => normalize(d.id, d.data()));
    }
    return out;
  },
  demoClear() {
    if (MODE !== "demo") return;
    localStorage.removeItem(LS_KEY);
    queueMicrotask(() => demoListeners.forEach(fn => fn()));
  }
};
