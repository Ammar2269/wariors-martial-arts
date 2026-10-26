// Mobile menu, footer year and today's opening hours.
(function () {
  const btn = document.querySelector(".menu-btn");
  const nav = document.getElementById("nav");
  if (btn && nav) {
    btn.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    nav.addEventListener("click", e => {
      if (e.target.closest("a")) {
        nav.classList.remove("open");
        btn.setAttribute("aria-expanded", "false");
      }
    });
  }

  document.querySelectorAll("[data-year]").forEach(el => { el.textContent = new Date().getFullYear(); });

  const hours = document.getElementById("hours");
  if (hours) {
    const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "Asia/Dubai" }).format(new Date());
    const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
    const row = hours.querySelector(`tr[data-day="${idx}"]`);
    if (row) row.classList.add("today");
  }
})();
