# Browser regression evidence

Run `npm ci`, `npx playwright install chromium`, `npm test`, and `npm run lint`.
The tests use Node's native test runner and pinned Playwright. `lint` checks the
syntax of both inline application scripts and the test scripts; it is not a
general style linter. The application itself has no npm runtime dependency.

`TRACKER_SOURCE` can select an exact HTML source file for a regression run.
For example, in PowerShell:

```powershell
$env:TRACKER_SOURCE = '/absolute/path/to/base/lopatcong-game-tracker (6).html'
npm test
Remove-Item Env:TRACKER_SOURCE
npm test
```

Each test creates a separate Chromium context with service workers blocked.
Request routing serves only the selected HTML and, for adapter tests, two exact
Firebase module URLs with small local fakes. All other requests are aborted.
The roster, teams, opponents, clock, cloud snapshots, and upload results are
synthetic. Tests exercise the real application scripts and browser localStorage;
reload checks read the same browser storage after a new document loads.

| Criterion | Direct assertions in `tracker.test.cjs` | Boundary and limitation |
|---|---|---|
| SAVE-1 | Injected history-write failure keeps score, minutes, and stable ID; reload retains them; retry persists one matching report. | Actual browser storage and reload, with a quota exception injected into this disposable browser context. Does not simulate every storage device failure. |
| SAVE-2 | Offline report survives reload, empty/stale snapshots and another save; successful upload and cloud-only reports are cached. | Actual browser persistence; remote snapshots and upload acknowledgements are simulated. |
| SAVE-3 | Retries use `setDoc` at the same report ID; errors retain pending state; confirmed snapshots and online recovery retry; cache/pending snapshots do not confirm; existing legacy IDs are not uploaded again. | Actual Firebase adapter module imports use fake SDK functions. Dispatch and client confirmation logic are exercised; server durability, rules, and cross-device behavior are unverified. |
| SAVE-4 | Repeated finalization produces one report/dispatch; the report is stored before the upload promise resolves; denied upload displays pending/local status; late acknowledgement clears stale failures; failed cloud-cache writes cannot claim local persistence. | Browser handlers, actual storage failures/readback, and mocked upload calls. |
| DATA-1 | Invalid remote shapes/numbers cannot break good history or execute the HTML marker; corrupt local history remains byte-for-byte recoverable; legacy reports remain readable. | Browser ingest, rendering, and storage. The test does not establish who can write to the live database. |
| CLOCK-1 | Ten-minute first half; invalid durations rejected or safely retained; deadline cap, paused break, and running reload preserve hand-calculated times. | Real browser execution with a deterministic clock and manually advanced ticks. Background mobile scheduling is not reproduced. |
| REPORT-1 | Departed player retains ten minutes and is excluded from absence list; nonparticipant is absent. | Report generated from browser match state. |
| REPORT-2 | Running subtraction yields four minutes, then five after another minute; signed unallocated adjustments reconcile totals; corrections survive reload; legacy missing position fields remain readable. | Generated report and browser persistence. |

The original-source run is expected to fail the reliability assertions while the
existing deadline, pause/resume, and running reload controls pass. Red/green runs
against separate source files provide regression evidence without mutating the
application. Fake SDK acknowledgements do not prove a report reached Firestore.
