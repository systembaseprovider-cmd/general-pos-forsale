# General POS for Windows

The desktop installer runs the existing POS server locally and stores its SQLite database and backups in the current Windows user's Electron application-data folder. It does not include the repository `.env`, MongoDB credentials, or the development `pos.db`.

## Build the installer

On a Windows x64 computer with Node.js installed:

```powershell
npm install
npm run desktop:dist
```

The unsigned NSIS installer is written to `dist\General POS Setup <version>.exe`. Windows may display a SmartScreen warning because the installer is not code-signed.

## First launch

The app creates a local administrator with a randomly generated temporary password and shows it in a first-run dialog. Sign in, change that password, then add the store's actual products and opening stock. Sample products are deliberately not added by the desktop build.

## Data and backups

Database: `%APPDATA%\general-pos\pos.db`  
Backups: `%APPDATA%\general-pos\backups`

The installer intentionally does not bundle the development database. Back up or migrate existing sales data separately before moving an existing store to the desktop installation. Uninstalling the app does not intentionally remove this user data; do not delete the application-data folder unless the database and backups are no longer needed. The current cashier's in-progress cart and held orders are saved in that app's browser storage and restored after a page refresh.

This is a single-computer, local POS build. It does not synchronize sales to MongoDB, and it does not process card, bank, or e-wallet payments.

## X/Z readings

Only administrators can access X/Z readings in Settings. X-reading shows one user's sales, refunds, and voids for a Philippine business date without closing the day. Z-reading previews the branch totals and, once finalized, stores a final daily snapshot. Finalizing Z blocks new sales, refunds, and voids for that branch until the next business day in `Asia/Manila`; reports and settings remain available. A Z-reading cannot be undone from the app.
