# Wariors Martial Arts Club: admin dashboard

A private, phone-friendly admin dashboard for **Wariors Martial Arts Club** (Emirates City, Ajman). It replaces the club's Excel sheets. 5–7 admins share **one username and password**.

Plain HTML, CSS and JavaScript. There's no build step. Data is stored in **Firebase** (free Spark plan).

> **No member data is in this repository.** The club's records live only in the Firebase database. The repo is public, so never commit spreadsheets or exports; `.gitignore` blocks `*.xlsx`, `*.csv` and `*.json`.

## What it does

- **Dashboard**: money collected this month, money owed, renewals due, active members, expenses and net. Also lists renewals due, balances owed, kit to hand out, bills, today's classes and recent activity.
- **Members**: details, joining date, date of birth, guardian, programs and notes. Everything can be edited later, and a corrected name updates on all their payments and memberships. Pause (vacation or hold), cancel (date and reason kept), re-join, and merge duplicates.
- **Cancelled members**: a WhatsApp message asking whether they want to cancel for sure or renew, with their answer noted (wants to renew, confirmed, no reply).
- **Memberships & renewals**: each membership has a start date, end date, plan, package price and kit price, like the old Excel sheet. The app works out automatically who is **active**, **ending soon**, **expired** or **owing money**. Renewing takes one tap, and the dates and price fill themselves in from the fee plans.
- **Payments**: link to a membership or charge to clear a balance. Record the receipt voucher number and attach its photo; payments can be edited afterwards. Receipts can be printed or sent on WhatsApp, and WhatsApp reminders cover renewals and money owed. The payment log can be exported per month.
- **Receipts & vouchers**: photos of the club's paper Receipt Vouchers (سند قبض, money in) and Payment Vouchers (سند صرف, money out). Drag photos anywhere onto the admin, or take them with the phone. Each photo holds the voucher's number, date, name, amount, cash/cheque and "being", and links to its payment or expense. **Send to the accountant** shares the photos (phone share menu → WhatsApp group) with a summary and marks them as sent. Photos are shrunk to about 200 KB and stored in Firestore, so no paid file storage is needed.
- **Kit & stock**: sell gloves, mouth guards and so on from stock (paid or owed), add stock, and track kit still to hand out.
- **Expenses & bills**: monthly bills (FEWA, phone, rent…) to tick off, plus expenses paid by cash, petty cash, card or bank.
- **Class schedule**: the weekly timetable, with today's classes on the dashboard. Edit it in Settings.
- **Trial requests, attendance and reports**: month-by-month income and expenses, a **cash book** with a running balance (like the ACCOUNTS sheet), and cancellation reasons.
- **Activity log**: every change, with the name of who made it and when. Nobody can edit or delete it.
- **Phones**: bottom tab bar, a "+" quick-add button, tables shown as cards, and it can be added to the home screen like an app.

## Shared login

Firebase needs an email address, so the username `wariors` signs in as `wariors@<project>.firebaseapp.com`. A full email address also works. On each device, the app asks **"Who's using this?"** once, so the activity log shows real names even though everyone uses the same login.

Change the password in **Settings → Shared login**, for example when someone leaves.

## Demo mode

While `js/firebase-config.js` has an empty `apiKey`, the dashboard runs in demo mode: no password, made-up sample data, saved only in that browser. **Never put real data in demo mode.**

## Going live (about 15 minutes, free)

Use a dedicated Google account for the club's system (not a personal one), so it can be handed to the owners later.

1. https://console.firebase.google.com → **Add project** (e.g. `wariors-admin`). Analytics: off.
2. **Build → Firestore Database → Create database** → production mode → location `me-central1`.
3. **Build → Authentication → Get started → Email/Password → Enable.**
4. **Authentication → Users → Add user**: email `wariors@<project-id>.firebaseapp.com`, plus a strong password. Also turn off **Settings → User actions → Enable create (sign-up)** so nobody can make their own login.
5. `firestore.rules` already treats that email as staff. Extra logins (if ever needed) go in a Firestore collection `admins` with the user's UID as the document ID.
6. **Firestore → Rules**: paste `firestore.rules` → **Publish**.
7. **Project settings → Your apps → Web (`</>`)** → copy the config values into `js/firebase-config.js`.
8. **Authentication → Settings → Authorized domains**: add the site's domain (e.g. `wariors-admin.netlify.app`).
9. Deploy, sign in, then import the prepared data file with **Settings → Restore / import file** (from the admin's computer, not from the repo).

To hand the system over, add the owners' Gmail as **Owner** under Firebase **Project settings → Users and permissions**.

## Hosting

Any static host works. On Netlify, the free plan has no password protection, so a small Edge Function asks for the username and password before anything loads, until the Firebase login takes over. That lock lives in the deploy copy, not in this repo.

## Importing the club's Excel sheets

The original sheets were converted with a one-off script, kept outside this repo. Along the way it:

- fixed dates that Excel had stored month-first (11/8/26 = 11 Aug, not 8 Nov)
- skipped money counted twice (the cash book versus the collection and petty-cash sheets)
- left out transfers into petty cash
- linked payments to members only when the name was unambiguous
- added October renewals that had been paid but weren't yet in the membership sheet

A "please check" list came with it, covering possible duplicate people, balances and fixed dates.
