# Ledger

Personal spending tracker. Installable web app (PWA) hosted on GitHub Pages, synced through Firebase.

- `index.html`: the page and styles
- `app.js`: the app (bundled, includes the Firebase SDK)
- `config.js`: your Firebase project settings (the only file you edit)
- `sw.js`: offline support / instant open
- `manifest.webmanifest`, `icons/`: app name and home-screen icon

Data is stored in Firestore at `users/{your uid}/...`. Only your signed-in account can read or write it (see the Firestore rules).
