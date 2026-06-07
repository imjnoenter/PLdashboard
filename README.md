# Mulan P&L 🌸

A cute, pastel P&L journal that reads/writes directly to a Google Sheet, built for GitHub Pages.

## 1. Set up the Google Sheet backend

1. Open your spreadsheet (the "Mulan" sheet).
2. Go to **Extensions → Apps Script**.
3. Delete any starter code, paste in the contents of `Code.gs`.
4. Change the line `const PIN = 'CHANGE_ME';` to a secret PIN of your choosing (this is what unlocks the app — keep it private).
5. Click **Deploy → New deployment**.
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy**, authorize the permissions it asks for, then copy the **Web app URL**.
7. The script will automatically create `Entries` and `Goals` tabs in your spreadsheet on first use.

> Whenever you edit `Code.gs` (e.g. changing the PIN), choose **Deploy → Manage deployments → ✏️ Edit → New version** and redeploy — the URL stays the same.

## 2. Connect the frontend

Open `app.js` and set:

```js
const CONFIG = {
  APPS_SCRIPT_URL: 'PASTE_YOUR_DEPLOYED_WEB_APP_URL_HERE',
  ...
};
```

Until this is set, the app runs in **local demo mode** — any PIN unlocks it and data is stored only in your browser (handy for previewing the UI before the backend is wired up).

## 3. Run it locally

From this folder:

```
npx serve .
```

or

```
python -m http.server 8000
```

then open the printed `localhost` URL in your browser (or on your iPhone via your computer's local IP, e.g. `http://192.168.x.x:8000`).

## 4. Deploy to GitHub Pages

Push this folder to a GitHub repo and enable **Pages** (Settings → Pages → deploy from branch). No build step needed — it's plain HTML/CSS/JS.

## Notes

- **Currency:** USD is the storage currency; the THB toggle is purely a display conversion using a live exchange rate (fetched from `open.er-api.com`, cached, with a hardcoded fallback `USD_TO_THB_DEFAULT = 35` in `app.js`).
- **PIN:** stored in `localStorage` on each device and checked server-side by `Code.gs`. It is never committed to the repo.
- **Add to Home Screen** on iPhone for the best experience — it behaves like a native app and keeps your PIN/session more reliably than a Safari tab.
