# LopatSoccer

A browser-based soccer game tracker for attendance, substitutions, playing time, goals, match reports, and season summaries.

Open **index.html** to use the maintained tracker. It redirects to `lopatcong-game-tracker (6).html`, which remains a self-contained file. The other numbered and unnumbered tracker files are legacy snapshots. They share browser storage keys with the maintained version; avoid switching between them when recording a match.

You can also serve this folder using a static web server. No application build step is required. Browser storage is specific to the browser and site origin, so use the same URL to return to your saved games. Opening a downloaded file and opening a hosted copy may use different storage.

## Saving and recovery

- Finalize saves the match on the device before clearing the board. If the browser cannot save, the current match is retained and an error is shown.
- Reports awaiting upload remain in local history. Cloud updates are merged with that history rather than replacing it. Use the retry control when connectivity returns.
- A pending upload is not a confirmed cloud save. The history view distinguishes local or pending reports from confirmed reports.
- New reports use a stable match ID so a retry writes the same cloud document. Existing valid reports remain readable. Legacy reports are reconciled against a confirmed cloud snapshot before upload.
- Invalid records are rejected before display. If local history contains malformed data, the app preserves the original storage and blocks replacement writes so that data can be recovered.

Local storage is a recovery copy, not a permanent backup. Clearing site data or changing browsers removes access to that local copy. Export reports before clearing storage. This app does not yet cache its HTML and Firebase libraries for a fresh offline launch.

## Playing time

Set the half length before starting. The countdown uses the selected duration. Pausing excludes the break from player minutes, and a delayed timer callback cannot credit time beyond the end of the half.

Marking a player unavailable removes them from the field but preserves minutes already played in the match report. Manual minute corrections settle the active shift first. Corrections are recorded separately as unallocated minutes because a missed substitution does not identify which position to credit. Unallocated minutes also account for missing position measurements in older reports and rounding differences. Position minutes plus the signed adjustment reconcile to the total.

## Firebase

The tracker contains the existing Firebase web configuration and reads/writes the `lopatcong_games` collection. The web configuration identifies the project; it does not enforce access control. The project owner must manage access with Firestore Security Rules and any required authentication.

This repository does not contain the deployed Firestore rules or hosting configuration. The reliability changes do not change either. Before deploying, verify the intended access policy and that rules permit the application's report schema, including `unallocatedMin`, and writes to stable document IDs. Client-side validation does not replace server-side validation or authorization.

Firestore APIs: [writing a document with an explicit ID](https://firebase.google.com/docs/firestore/manage-data/add-data) and [snapshot metadata and errors](https://firebase.google.com/docs/firestore/query-data/listen).

## Development checks

Use Node.js 20 or newer:

```sh
npm ci
npx playwright install chromium
npm test
npm run lint
```

The browser tests use synthetic players, actual browser localStorage, a controlled clock, and simulated cloud boundaries. External network requests are blocked, so the tests do not read or write the configured Firebase project. They verify browser behavior and local persistence, not deployed Firestore permissions or server durability.

Regression coverage includes failed saves, offline history merging, repeated finalization, malformed records, half-length selection, early departure, manual corrections, pause/resume, and reload. Physical-phone touch behavior and real mobile background throttling require separate device checks.

## Follow-up work

Season totals still identify players by display name. Stable player IDs and migration of existing name-only reports, tap/keyboard substitutions, backup/restore, and editing finalized matches remain separate improvements.
