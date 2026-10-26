// Free-trial form: saves the request for the admin dashboard and offers WhatsApp.
import { store } from "./store.js";

const WHATSAPP = "971562613563";
const form = document.getElementById("trial-form");
const status = document.getElementById("form-status");

const params = new URLSearchParams(location.search);
const wanted = params.get("program");
if (wanted) {
  const opt = [...form.program.options].find(o => o.value.toLowerCase() === wanted.toLowerCase());
  if (opt) form.program.value = opt.value;
}

function show(kind, html) {
  status.className = `form-status show ${kind}`;
  status.innerHTML = html;
}

function waLink(d) {
  const lines = [
    "Hi Wariors! I'd like to book a free trial class.",
    `Name: ${d.name}`,
    `Program: ${d.program}`,
    `Who: ${d.ageGroup}`,
    `Best time: ${d.preferredTime}`
  ];
  if (d.message) lines.push(`Note: ${d.message}`);
  return `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(lines.join("\n"))}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

form.addEventListener("submit", async e => {
  e.preventDefault();
  if (form.website.value) return; // bots fill the hidden field

  const d = {
    name: form.name.value.trim(),
    phone: form.phone.value.trim(),
    program: form.program.value,
    ageGroup: form.ageGroup.value,
    preferredTime: form.preferredTime.value,
    message: form.message.value.trim()
  };
  if (!d.name) { form.name.focus(); return show("err", "Please enter your name."); }
  if (d.phone.replace(/\D/g, "").length < 7) { form.phone.focus(); return show("err", "Please enter a valid mobile number so we can reach you."); }

  const wa = waLink(d);

  if (store.mode === "demo") {
    // No database connected yet: WhatsApp is the way the request reaches the club.
    window.open(wa, "_blank", "noopener");
    store.addPublicLead(d).catch(() => {});
    show("ok", `<strong>Thanks, ${esc(d.name)}!</strong> WhatsApp has opened with your request. Just press send. <a href="${wa}" target="_blank" rel="noopener" style="color:var(--orange)">Didn't open? Tap here.</a>`);
    form.reset();
    return;
  }

  const btn = form.querySelector("[type=submit]");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    await store.addPublicLead(d);
    show("ok", `<strong>Thanks, ${esc(d.name)}!</strong> We've received your request and will contact you soon to book your class. Want a faster reply? <a href="${wa}" target="_blank" rel="noopener" style="color:var(--orange)">Send it on WhatsApp too</a>.`);
    form.reset();
  } catch {
    show("err", `We couldn't send the form just now. <a href="${wa}" target="_blank" rel="noopener" style="color:var(--orange)">Send your request on WhatsApp instead</a>.`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Request my free trial";
  }
});
