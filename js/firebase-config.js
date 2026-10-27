// Firebase web app config. Paste the values from:
// Firebase console → Project settings → General → Your apps → (web app) → SDK setup and configuration → Config.
//
// While apiKey is empty the dashboard runs in DEMO MODE: it opens without a password and saves data
// only in that browser. Fill it in (and publish firestore.rules) to switch to the shared database
// with the staff login. These values are not secret; the security rules protect the data. See README.md.
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
