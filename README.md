# Wariors Martial Arts Club: website + admin dashboard

New website for **Wariors Martial Arts Club**, Lavender Tower P6-610, Emirates City, Ajman, plus a private admin dashboard that replaces the club's Excel sheets.

Plain HTML, CSS and JavaScript. There is no build step and nothing to install. Data is stored in **Firebase** (free Spark plan).

## What's inside

| Path | What it is |
|---|---|
| `index.html` `programs.html` `about.html` `contact.html` | Public website (dark theme, mobile-friendly, SEO tags, LocalBusiness schema) |
| `contact.html` + `js/trial-form.js` | Free-trial form: saves the request to the dashboard and offers WhatsApp |
| `admin/` | Staff dashboard (sign-in required, hidden from Google) |
| `js/store.js` | Data layer: Firebase when configured, browser-only demo mode when not |
| `js/firebase-config.js` | **The only file you edit to go live** |
| `firestore.rules` | Database security rules |

## The admin dashboard

Open `/admin/` (there's also a small "Staff login" link in the footer).

- **Dashboard**: money in and out this month, who hasn't paid, bills due, equipment needing repair, recent activity, and a 6-month income vs expenses chart.
- **Members**: add, edit, pause (travel or injury, no fees while paused), cancel (date and reason kept), re-join. Kids have guardian details. You can record belt or rank, emergency contact and medical notes.
- **Payments**: pick a month and see every member as *Paid / Partial / Due / Overdue*, worked out automatically from each member's fee, billing day and plan (monthly, 3, 6 or 12 months). One click records a payment, with a receipt number, a printable receipt and a WhatsApp receipt. Reminder messages go out by WhatsApp. Other income such as registration, grading, gear sales and drop-ins is logged too.
- **Expenses & bills**: recurring monthly bills (rent, Etihad WE electricity & water, internet, salaries) show up every month to tick off. One-off expenses and unpaid supplier invoices have due dates.
- **Equipment**: inventory with quantity, condition, cost, supplier and next service date. Buying equipment also logs the expense. Repairs are logged as expenses.
- **Trial requests**: requests from the website form arrive here automatically. Each has a status (New → Contacted → Trial booked → Joined), WhatsApp follow-up and a "Make member" button.
- **Attendance**: quick check-in. It flags members who haven't trained in 14+ days and warns at check-in if someone owes money.
- **Reports**: month-by-month income, expenses, net, joins and cancellations; income by type, method and program; expenses by category; cancellation reasons.
- **Activity log**: every change is recorded automatically with who did it and when. Entries can't be edited or deleted.
- **Settings**: membership plans, recurring bills, reminder text, grace days. Also **import members from Excel (CSV)**, export any list to Excel, and full backup and restore.

## Demo mode (works right away)

While `js/firebase-config.js` has an empty `apiKey`, the site runs in **demo mode**:

- `/admin/` opens without a password, with optional sample data. Everything is saved **only in that browser**.
- The trial form sends the request by **WhatsApp** to +971 56 261 3563.

Use it to show the client. Don't use demo mode for real records.

## Going live with Firebase (free, about 15 minutes)

1. Go to https://console.firebase.google.com → **Add project** (e.g. `wariors-club`). Google Analytics isn't needed.
2. **Build → Firestore Database → Create database** → production mode → location `me-central1` (Doha) or the nearest one.
3. **Build → Authentication → Get started → Email/Password → Enable.**
4. **Authentication → Users → Add user**: the owner's email and a strong password. Copy the **User UID**.
5. **Firestore → Start collection** `admins` → Document ID = that UID → add any field (e.g. `name: "Owner"`) → Save.
6. **Firestore → Rules**: paste everything from `firestore.rules` → **Publish**.
7. **Project settings → General → Your apps → Web (`</>`)** → register the app → copy the `firebaseConfig` values into `js/firebase-config.js`.
8. **Authentication → Settings → Authorized domains**: add the live domain (e.g. `www.wariorsmartialarts.com`).
9. Deploy the folder (see below), open `/admin/` and sign in.

To add staff later, repeat steps 4–5 for each person. To remove access, delete their `admins` document.

## Hosting

It's a static site, so any static host works:

- **Netlify**: drag the folder onto app.netlify.com, or connect this GitHub repo. Then point `wariorsmartialarts.com` at it.
- **GitHub Pages**: Settings → Pages → deploy from `main` / root.
- The client's current host also works if it serves plain HTML files.

The canonical URLs, `sitemap.xml` and `robots.txt` assume `https://www.wariorsmartialarts.com/`.

## Moving from Excel

1. In Excel: **File → Save As → CSV UTF-8**. Put column titles in the first row (Name, Phone, Program, Fee, Start date, Status…).
2. Admin → **Settings → Import members from CSV**. You can download a template there too.
3. Leave "Count months before this month as already paid" ticked, so imported members don't show years of fake debt.

## To confirm with the client

- **Opening hours**: Google Maps says Mon–Sat 9 AM–11 PM, closed Sunday. The old site's contact page said Mon–Sat 9 AM–6 PM. The new site uses Google's hours.
- **Photos**: the current site mostly uses stock photos, and those are reused here. Real photos of the club, coaches and classes will convert much better.
- **Coaches**: names, ranks and certifications would make a strong "Meet the coaches" section. None are published anywhere today.
- **Prices and timetable**: not on the site, by choice. Add them if the club wants them public.
- **Facebook and YouTube**: the old site linked to placeholder pages, so they're left out. Send the real links to add them.
- **Spelling**: "Wariors" (one R) is kept as the brand name, matching the logo and domain.

## Data and privacy notes

- Member data is only readable by signed-in staff listed in `admins` (enforced by `firestore.rules`, not just the page).
- The public form can only *create* a trial request with fixed fields. It can't read anything.
- Download a backup from Settings regularly. Firebase's free plan has no automatic backups.
