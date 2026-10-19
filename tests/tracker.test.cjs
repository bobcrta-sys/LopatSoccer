const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const source = process.env.TRACKER_SOURCE || path.join(__dirname, '..', 'lopatcong-game-tracker (6).html');
const html = fs.readFileSync(source, 'utf8');
const origin = 'http://tracker.test';
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const fakeFirestore = `
  const state = window.__sdk = { calls: [], callback: null, options: null, reject: false, hold: false, resolves: [] };
  export const getFirestore = () => ({});
  export const collection = (_db, name) => ({ path: name });
  export const doc = (collection, id) => ({ path: collection.path + '/' + id, id });
  export const query = collection => collection;
  export const orderBy = () => ({});
  export const addDoc = async (collection, report) => { state.calls.push({ method: 'addDoc', path: collection.path, report }); };
  export const setDoc = async (reference, report) => {
    state.calls.push({ method: 'setDoc', path: reference.path, report });
    if (state.reject) throw new Error('Synthetic offline SDK');
    if (state.hold) await new Promise(resolve => state.resolves.push(resolve));
  };
  export const onSnapshot = (_query, options, callback) => {
    state.options = typeof options === 'function' ? null : options;
    state.callback = typeof options === 'function' ? options : callback;
    return () => {};
  };
`;

async function fresh(t, { sdk = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === origin + '/tracker') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    const modules = {
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js': 'export const initializeApp = () => ({});',
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js': fakeFirestore
    };
    if (sdk && Object.hasOwn(modules, url)) return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: modules[url] });
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(() => {
    window.__testNow = Number(localStorage.getItem('__test-clock') || 1800000000000);
    Date.now = () => window.__testNow;
    window.setInterval = () => 1;
  });
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  await page.goto(origin + '/tracker');
  await ready(page);
  if (sdk) await page.waitForFunction(() => typeof window.__sdk?.callback === 'function');
  await page.evaluate(() => {
    players = ['Synthetic Player A', 'Synthetic Player B', 'Synthetic Player C'].map(mkPlayer);
    players.forEach((p, i) => { p.id = 'synthetic-' + i; });
    document.getElementById('teamNameInput').value = 'Synthetic Team';
    document.getElementById('opponentInput').value = 'Synthetic Opponent';
    populateGoalSelects(); render();
  });
  return page;
}
async function ready(page) {
  await page.waitForFunction(() => typeof doFinalizeGame === 'function' && document.querySelectorAll('.chip').length > 0);
}
async function reload(page) {
  await page.evaluate(() => localStorage.setItem('__test-clock', String(window.__testNow)));
  await page.reload();
  await ready(page);
}

test('CLOCK-1: choosing 10 minutes starts the first half at 10:00', async t => {
  const page = await fresh(t);
  await page.locator('#minsInput').fill('10');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => ({ remaining: gameRemainingSec, deadline: (halfEndAt - Date.now()) / 1000, display: document.getElementById('clockDisplay').textContent })),
    { remaining: 600, deadline: 600, display: '10:00' });
});

test('REPORT-1: a departed player keeps 10 minutes and is not listed absent', async t => {
  const page = await fresh(t);
  const report = await page.evaluate(() => {
    putOnField(players[0], 'gk'); startClock(); window.__testNow += 600000; pauseClock();
    togglePresent(players[0].id); togglePresent(players[1].id);
    return buildReport();
  });
  assert.equal(report.players.find(p => p.name === 'Synthetic Player A')?.totalMin, 10);
  assert.ok(!report.absentPlayers.includes('Synthetic Player A'));
  assert.ok(report.absentPlayers.includes('Synthetic Player B'));
});

test('REPORT-2: subtracting a running minute gives 4, then the next minute gives 5', async t => {
  const page = await fresh(t);
  const actual = await page.evaluate(() => {
    putOnField(players[0], 'gk'); startClock(); window.__testNow += 300000;
    const before = liveTotal(players[0]); adjustMinutes(players[0].id, -1);
    const corrected = liveTotal(players[0]); window.__testNow += 60000;
    const later = liveTotal(players[0]); pauseClock();
    return { before, corrected, later, row: buildReport().players.find(p => p.name === 'Synthetic Player A') };
  });
  assert.deepEqual([actual.before, actual.corrected, actual.later], [300, 240, 300]);
  assert.equal(actual.row.unallocatedMin, -1);
  assert.equal(actual.row.totalMin, actual.row.gkMin + actual.row.defMin + actual.row.midMin + actual.row.stMin + actual.row.unallocatedMin);
});

test('REPORT-2: positive correction is explicit and survives a live reload', async t => {
  const page = await fresh(t);
  await page.evaluate(() => {
    putOnField(players[0], 'gk'); startClock(); window.__testNow += 300000; pauseClock();
    adjustMinutes(players[0].id, 1);
  });
  await reload(page);
  const row = await page.evaluate(() => buildReport().players.find(p => p.name === 'Synthetic Player A'));
  assert.equal(row.totalMin, 6);
  assert.equal(row.unallocatedMin, 1);
  assert.equal(row.totalMin, row.gkMin + row.defMin + row.midMin + row.stMin + row.unallocatedMin);
});

test('SAVE-1: history quota failure preserves the played match and ID across reload and retry', async t => {
  const page = await fresh(t);
  const failed = await page.evaluate(async () => {
    putOnField(players[0], 'gk'); startClock(); window.__testNow += 300000; logOurGoal();
    const id = buildReport().id;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'lopatcong-games') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    try { await doFinalizeGame(); } finally { Storage.prototype.setItem = original; }
    return { id, history: localStorage.getItem('lopatcong-games'), goals: goals.length, seconds: liveTotal(players[0]), message: document.getElementById('confirmModalText').textContent };
  });
  assert.equal(failed.history, null);
  assert.equal(failed.goals, 1, 'failed history writes must not clear the score');
  assert.equal(failed.seconds, 300, 'failed history writes must not clear played minutes');
  assert.match(failed.message, /save|storage|space|finaliz/i);
  await reload(page);
  const resumed = await page.evaluate(() => ({ id: buildReport().id, goals: goals.length, seconds: liveTotal(players[0]) }));
  assert.deepEqual(resumed, { id: failed.id, goals: 1, seconds: 300 });
  const retried = await page.evaluate(async () => {
    window.__testNow += 1000; await doFinalizeGame();
    return JSON.parse(localStorage.getItem('lopatcong-games'));
  });
  assert.equal(retried.length, 1);
  assert.equal(retried[0].id, failed.id);
  assert.equal(retried[0].ourGoals, 1);
});

test('SAVE-2: offline report survives reload, empty and stale snapshots, and the next save', async t => {
  const page = await fresh(t);
  await page.evaluate(async () => {
    window.__firebaseSaveGame = async () => { throw new Error('Synthetic offline'); };
    document.getElementById('opponentInput').value = 'Synthetic First';
    logOurGoal(); await doFinalizeGame();
  });
  await reload(page);
  assert.equal(await page.evaluate(() => savedGames[0].opponentName), 'Synthetic First');
  const actual = await page.evaluate(async () => {
    window.__firebaseSaveGame = async () => { throw new Error('Synthetic offline'); };
    window.__onGamesUpdate([], { confirmed: true });
    const afterEmpty = savedGames.map(g => g.opponentName);
    const stale = buildReport(); stale.id = 'synthetic-stale'; stale.opponentName = 'Synthetic Older';
    window.__onGamesUpdate([stale], { confirmed: true });
    const afterStale = savedGames.map(g => g.opponentName);
    document.getElementById('opponentInput').value = 'Synthetic Second'; window.__testNow += 1000;
    logOurGoal(); await doFinalizeGame();
    return { afterEmpty, afterStale, persisted: JSON.parse(localStorage.getItem('lopatcong-games')).map(g => g.opponentName) };
  });
  assert.deepEqual(actual.afterEmpty, ['Synthetic First']);
  assert.deepEqual(actual.afterStale.sort(), ['Synthetic First', 'Synthetic Older']);
  assert.deepEqual(actual.persisted.sort(), ['Synthetic First', 'Synthetic Older', 'Synthetic Second']);
});

test('SAVE-2: successful cloud dispatch also leaves a durable browser report', async t => {
  const page = await fresh(t);
  await page.evaluate(async () => {
    window.__testUploads = [];
    window.__firebaseSaveGame = async report => { window.__testUploads.push(report); window.__onGamesUpdate([report], { confirmed: true }); };
    window.__onGamesUpdate([], { confirmed: true });
    logOurGoal(); await doFinalizeGame();
  });
  await page.waitForFunction(() => window.__testUploads.length === 1);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('lopatcong-games')));
  assert.equal(persisted?.length, 1);
  assert.equal(persisted[0].ourGoals, 1);
  assert.equal(persisted[0].id, await page.evaluate(() => window.__testUploads[0].id));
  await reload(page);
  assert.equal(await page.evaluate(() => savedGames[0]?.ourGoals), 1);
});

test('SAVE-2: a valid cloud-only report is cached for offline reload', async t => {
  const page = await fresh(t);
  await page.evaluate(() => {
    const report = buildReport(); report.id = 'synthetic-cloud'; report.opponentName = 'Synthetic Cloud';
    window.__onGamesUpdate([report], { confirmed: true });
  });
  await reload(page);
  assert.equal(await page.evaluate(() => savedGames.find(g => g.id === 'synthetic-cloud')?.opponentName), 'Synthetic Cloud');
});

test('SAVE-4: repeated finalize cannot dispatch two reports while the first save is pending', async t => {
  const page = await fresh(t);
  const actual = await page.evaluate(async () => {
    window.__testReports = [];
    window.__testResolve = [];
    window.__firebaseSaveGame = report => { window.__testReports.push(report); return new Promise(resolve => window.__testResolve.push(resolve)); };
    window.__onGamesUpdate([], { confirmed: true });
    logOurGoal();
    const first = doFinalizeGame();
    const second = doFinalizeGame();
    await Promise.resolve();
    const result = { calls: window.__testReports.length, scores: window.__testReports.map(g => g.ourGoals), locallySaved: JSON.parse(localStorage.getItem('lopatcong-games') || '[]').length };
    window.__testResolve.forEach(resolve => resolve());
    await Promise.all([first, second]);
    return result;
  });
  assert.equal(actual.calls, 1);
  assert.deepEqual(actual.scores, [1]);
  assert.equal(actual.locallySaved, 1, 'history must be written before the cloud promise resolves');
});

test('SAVE-4: denied upload is described as local or pending rather than synced', async t => {
  const page = await fresh(t);
  await page.evaluate(async () => {
    window.__firebaseReady = true;
    window.__testRejected = false;
    window.__firebaseSaveGame = async () => { window.__testRejected = true; throw new Error('Synthetic denied'); };
    window.__onGamesUpdate([], { confirmed: true });
    logOurGoal(); await doFinalizeGame(); switchTab('games');
  });
  await page.waitForFunction(() => window.__testRejected);
  const status = await page.locator('#syncStatus').textContent();
  assert.match(status, /local|pending|device|retry/i);
  assert.doesNotMatch(status, /synced live/i);
});

test('DATA-1: malformed remote numeric fields cannot execute HTML and good reports survive', async t => {
  const page = await fresh(t);
  await page.evaluate(() => {
    window.__injected = false;
    const good = buildReport(); good.id = 'synthetic-good';
    const bad = structuredClone(good); bad.id = 'synthetic-bad';
    bad.ourGoals = '<img src="http://blocked.invalid/test" onerror="window.__injected=true">';
    window.__onGamesUpdate([bad, good], { confirmed: true }); switchTab('games');
  });
  // Wait for a browser rendering turn so a rejected image's onerror would run.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.__injected), false);
  assert.deepEqual(await page.evaluate(() => savedGames.map(g => g.id)), ['synthetic-good']);
  assert.equal(await page.locator('.game-card').count(), 1);
});

test('DATA-1: malformed record shapes and nonfinite values do not break good history', async t => {
  const page = await fresh(t);
  const actual = await page.evaluate(() => {
    const good = buildReport(); good.id = 'synthetic-good';
    const badNumber = structuredClone(good); badNumber.id = 'synthetic-infinity'; badNumber.players[0].totalMin = Infinity;
    let error = null;
    try { switchTab('games'); window.__onGamesUpdate([{}, null, { ...good, id: 'synthetic-shape', goals: {} }, badNumber, good], { confirmed: true }); } catch (e) { error = String(e); }
    return { error, ids: savedGames.map(g => g?.id), cards: document.querySelectorAll('.game-card').length };
  });
  assert.equal(actual.error, null);
  assert.deepEqual(actual.ids, ['synthetic-good']);
  assert.equal(actual.cards, 1);
});

test('CLOCK-1: a late timer tick caps minutes at the half deadline', async t => {
  const page = await fresh(t);
  assert.deepEqual(await page.evaluate(() => {
    putOnField(players[0], 'gk'); startClock(); window.__testNow += 1800000; tick();
    return { seconds: liveTotal(players[0]), remaining: gameRemainingSec, running: gameRunning };
  }), { seconds: 1500, remaining: 0, running: false });
});

test('CLOCK-1: pause and resume exclude break time', async t => {
  const page = await fresh(t);
  assert.deepEqual(await page.evaluate(() => {
    putOnField(players[0], 'gk'); startClock(); window.__testNow += 120000; pauseClock();
    window.__testNow += 60000; startClock(); window.__testNow += 120000; pauseClock();
    return { seconds: liveTotal(players[0]), remaining: gameRemainingSec };
  }), { seconds: 240, remaining: 1260 });
});

test('CLOCK-1: a running game retains time and field position across reload', async t => {
  const page = await fresh(t);
  await page.evaluate(() => { putOnField(players[0], 'gk'); startClock(); window.__testNow += 300000; tick(); });
  await reload(page);
  assert.deepEqual(await page.evaluate(() => ({ seconds: liveTotal(players[0]), remaining: gameRemainingSec, running: gameRunning, slot: players[0].slotId })),
    { seconds: 300, remaining: 1200, running: true, slot: 'gk' });
});

test('CLOCK-1: invalid half lengths cannot create an invalid countdown', async t => {
  const page = await fresh(t);
  for (const value of ['0', '-1', '61', 'Infinity', 'NaN']) {
    const actual = await page.evaluate(value => {
      doRestartGame();
      const input = document.getElementById('minsInput');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      startClock();
      const result = { configured: getHalfLengthSec(), remaining: gameRemainingSec, running: gameRunning, deadline: halfEndAt === null ? null : (halfEndAt - Date.now()) / 1000 };
      pauseClock();
      return result;
    }, value);
    assert.ok(Number.isFinite(actual.configured) && actual.configured >= 60 && actual.configured <= 3600, `${value} produced invalid duration ${actual.configured}`);
    assert.ok(Number.isFinite(actual.remaining) && actual.remaining >= 60 && actual.remaining <= 3600, `${value} produced invalid countdown ${actual.remaining}`);
    if (actual.running) assert.equal(actual.deadline, actual.remaining);
    else assert.equal(actual.deadline, null, 'a rejected start must not leave an active deadline');
  }
});

test('DATA-1: corrupt local history is preserved and cannot be silently replaced by finalization', async t => {
  const page = await fresh(t);
  const corrupt = '{"synthetic-corrupt-history":';
  await page.evaluate(raw => localStorage.setItem('lopatcong-games', raw), corrupt);
  await reload(page);
  const actual = await page.evaluate(async () => {
    logOurGoal(); await doFinalizeGame(); switchTab('games');
    return { history: localStorage.getItem('lopatcong-games'), score: goals.length, warning: document.getElementById('syncStatus').textContent + ' ' + document.getElementById('confirmModalText').textContent };
  });
  assert.equal(actual.history, corrupt, 'corrupt history bytes must remain available for recovery');
  assert.equal(actual.score, 1, 'a blocked replacement must retain the played match');
  assert.match(actual.warning, /history|corrupt|recover|invalid|read/i);
});

test('DATA-1 and REPORT-2: valid legacy history remains readable with an explicit position adjustment', async t => {
  const page = await fresh(t);
  await page.evaluate(() => {
    const legacy = buildReport(); legacy.id = 'synthetic-legacy';
    Object.assign(legacy.players[0], { half1Min: 6, half2Min: 0, totalMin: 6, gkMin: 5, defMin: 0, midMin: 0, stMin: 0 });
    Object.assign(legacy.players[1], { half1Min: 4, half2Min: 0, totalMin: 4 });
    for (const field of ['gkMin', 'defMin', 'midMin', 'stMin']) delete legacy.players[1][field];
    legacy.players.forEach(row => { delete row.unallocatedMin; });
    delete legacy.targetMin;
    delete legacy._syncState;
    localStorage.setItem('lopatcong-games', JSON.stringify([legacy]));
  });
  await reload(page);
  const actual = await page.evaluate(() => { switchTab('games'); return { row: savedGames[0].players[0], older: savedGames[0].players[1], text: gameReportText(savedGames[0]) }; });
  assert.equal(actual.row.totalMin, 6);
  assert.equal(actual.row.unallocatedMin, 1);
  assert.equal(actual.row.totalMin, actual.row.gkMin + actual.row.defMin + actual.row.midMin + actual.row.stMin + actual.row.unallocatedMin);
  assert.equal(actual.older.totalMin, 4);
  assert.equal(actual.older.unallocatedMin, 4);
  assert.equal(actual.older.gkMin + actual.older.defMin + actual.older.midMin + actual.older.stMin, 0);
  assert.match(actual.text, /Synthetic Player A/);
  assert.equal(await page.locator('.game-card').count(), 1);
});

test('SAVE-3: explicit retry uses the same document ID and keeps a failed upload pending', async t => {
  const page = await fresh(t, { sdk: true });
  const pending = await page.evaluate(async () => {
    window.__sdk.reject = true;
    logOurGoal(); await doFinalizeGame();
    return { calls: window.__sdk.calls.length, report: JSON.parse(localStorage.getItem('lopatcong-games'))[0] };
  });
  assert.equal(pending.calls, 0, 'automatic writes wait for the first confirmed snapshot');
  assert.equal(pending.report._syncState, 'pending');
  assert.equal(await page.evaluate(() => typeof syncPendingGames), 'function');
  await page.evaluate(() => syncPendingGames());
  const rejected = await page.evaluate(() => ({ calls: window.__sdk.calls, report: JSON.parse(localStorage.getItem('lopatcong-games'))[0] }));
  assert.equal(rejected.calls.length, 1);
  assert.equal(rejected.calls[0].method, 'setDoc');
  assert.equal(rejected.calls[0].path, 'lopatcong_games/' + pending.report.id);
  assert.equal(rejected.report._syncState, 'pending');
  await page.evaluate(async () => { window.__sdk.reject = false; await syncPendingGames(); });
  const retried = await page.evaluate(() => ({ calls: window.__sdk.calls, report: JSON.parse(localStorage.getItem('lopatcong-games'))[0] }));
  assert.equal(retried.calls.length, 2);
  assert.equal(retried.calls[1].path, rejected.calls[0].path);
  assert.equal(retried.calls[1].report.id, pending.report.id);
  assert.equal(retried.report._syncState, 'confirmed');
});

test('SAVE-3: SDK cache and pending-write snapshots do not confirm a pending report', async t => {
  const page = await fresh(t, { sdk: true });
  const actual = await page.evaluate(async () => {
    logOurGoal(); await doFinalizeGame();
    const report = JSON.parse(localStorage.getItem('lopatcong-games'))[0];
    const emit = (fromCache, hasPendingWrites) => window.__sdk.callback({
      metadata: { fromCache, hasPendingWrites },
      forEach: callback => callback({ id: report.id, metadata: { hasPendingWrites }, data: () => report })
    });
    emit(true, false);
    const cached = JSON.parse(localStorage.getItem('lopatcong-games'))[0]._syncState;
    emit(false, true);
    const pending = JSON.parse(localStorage.getItem('lopatcong-games'))[0]._syncState;
    emit(false, false);
    const confirmed = JSON.parse(localStorage.getItem('lopatcong-games'))[0]._syncState;
    return { cached, pending, confirmed, calls: window.__sdk.calls.length, options: window.__sdk.options };
  });
  assert.equal(actual.cached, 'pending');
  assert.equal(actual.pending, 'pending');
  assert.equal(actual.confirmed, 'confirmed');
  assert.equal(actual.calls, 0, 'an already represented report must not be uploaded again');
  assert.equal(actual.options.includeMetadataChanges, true);
});

test('SAVE-3: confirmed snapshot and online recovery retry pending uploads', async t => {
  const page = await fresh(t, { sdk: true });
  const first = await page.evaluate(async () => {
    window.__sdk.reject = true;
    logOurGoal(); await doFinalizeGame();
    const beforeSnapshot = window.__sdk.calls.length;
    window.__sdk.callback({ metadata: { fromCache: false, hasPendingWrites: false }, forEach: () => {} });
    return beforeSnapshot;
  });
  assert.equal(first, 0);
  await page.waitForFunction(() => window.__sdk.calls.length === 1);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lopatcong-games'))[0]._syncState), 'pending');
  await page.evaluate(() => { window.__sdk.reject = false; window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => window.__sdk.calls.length === 2);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lopatcong-games'))[0]._syncState === 'confirmed');
  const calls = await page.evaluate(() => window.__sdk.calls);
  assert.equal(calls[0].method, 'setDoc');
  assert.equal(calls[0].path, calls[1].path);
});

test('SAVE-3: a legacy report represented in the first confirmed snapshot is never re-uploaded', async t => {
  const page = await fresh(t, { sdk: true });
  await page.evaluate(() => {
    const report = buildReport(); report.id = 'synthetic-legacy-existing'; delete report._syncState;
    localStorage.setItem('lopatcong-games', JSON.stringify([report]));
  });
  await reload(page);
  await page.waitForFunction(() => typeof window.__sdk?.callback === 'function');
  assert.equal(await page.evaluate(() => typeof syncPendingGames), 'function');
  await page.evaluate(() => syncPendingGames());
  assert.equal(await page.evaluate(() => window.__sdk.calls.length), 0, 'legacy reports must wait for the first server snapshot');
  const actual = await page.evaluate(async () => {
    const report = JSON.parse(localStorage.getItem('lopatcong-games'))[0];
    window.__sdk.callback({ metadata: { fromCache: false, hasPendingWrites: false }, forEach: callback => callback({ id: 'legacy-auto-generated-document-id', metadata: { hasPendingWrites: false }, data: () => report }) });
    await syncPendingGames();
    return { calls: window.__sdk.calls.length, reports: JSON.parse(localStorage.getItem('lopatcong-games')) };
  });
  assert.equal(actual.calls, 0);
  assert.equal(actual.reports.length, 1);
  assert.equal(actual.reports[0].id, 'synthetic-legacy-existing');
  assert.equal(actual.reports[0]._syncState, 'confirmed');
});

test('SAVE-1: a failed live reset after history commit cannot duplicate the report on reload', async t => {
  const page = await fresh(t);
  const committed = await page.evaluate(async () => {
    logOurGoal();
    const id = buildReport().id;
    const original = Storage.prototype.setItem;
    let injected = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'lopatcong-live-game' && JSON.parse(value).goals.length === 0) {
        injected++;
        throw new DOMException('Synthetic reset write failure', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    try { await doFinalizeGame(); } finally { Storage.prototype.setItem = original; }
    return { id, injected, history: JSON.parse(localStorage.getItem('lopatcong-games')), staleLive: JSON.parse(localStorage.getItem('lopatcong-live-game')) };
  });
  assert.ok(committed.injected > 0, 'the reset write fault must be exercised');
  assert.equal(committed.history.length, 1);
  assert.equal(committed.history[0].id, committed.id);
  assert.equal(committed.staleLive.goals.length, 1, 'storage still holds the already-finalized live game');
  await reload(page);
  const recovered = await page.evaluate(async () => {
    await doFinalizeGame();
    return { goals: goals.length, history: JSON.parse(localStorage.getItem('lopatcong-games')), newId: buildReport().id };
  });
  assert.equal(recovered.goals, 0);
  assert.equal(recovered.history.length, 1);
  assert.equal(recovered.history[0].id, committed.id);
  assert.notEqual(recovered.newId, committed.id);
});

test('SAVE-3 and SAVE-4: timeout retains the pending report and a late SDK acknowledgement clears stale failure status', async t => {
  const page = await fresh(t, { sdk: true });
  await page.evaluate(async () => { window.__sdk.hold = true; logOurGoal(); await doFinalizeGame(); });
  assert.equal(await page.evaluate(() => typeof syncPendingGames), 'function');
  const elapsed = await page.evaluate(async () => {
    const start = performance.now();
    await syncPendingGames();
    return performance.now() - start;
  });
  assert.ok(elapsed >= 5900 && elapsed < 15000, `the real upload timeout took ${elapsed} ms`);
  const timedOut = await page.evaluate(() => ({ state: JSON.parse(localStorage.getItem('lopatcong-games'))[0]._syncState, status: document.getElementById('syncStatus').textContent, calls: window.__sdk.calls.length }));
  assert.equal(timedOut.state, 'pending');
  assert.equal(timedOut.calls, 1);
  assert.match(timedOut.status, /timed out|timeout/i);
  await page.evaluate(() => window.__sdk.resolves.forEach(resolve => resolve()));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lopatcong-games'))[0]._syncState === 'confirmed');
  const confirmedStatus = await page.locator('#syncStatus').textContent();
  assert.match(confirmedStatus, /confirmed in cloud/i);
  assert.doesNotMatch(confirmedStatus, /failed|failure|timed out|timeout|upload pending/i, 'a late acknowledgement must clear stale upload failure notices when every report is confirmed');
  await page.evaluate(() => syncPendingGames());
  assert.equal(await page.evaluate(() => window.__sdk.calls.length), 1, 'a confirmed late acknowledgement must prevent another upload');
});

test('SAVE-4: an uncached cloud report stays visible without claiming local persistence', async t => {
  const page = await fresh(t);
  const actual = await page.evaluate(() => {
    const report = buildReport(); report.id = 'synthetic-uncached-cloud';
    const original = Storage.prototype.setItem;
    let injected = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'lopatcong-games') {
        injected++;
        throw new DOMException('Synthetic cloud-cache write failure', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    try { window.__onGamesUpdate([report], { confirmed: false }); } finally { Storage.prototype.setItem = original; }
    switchTab('games');
    return { injected, stored: localStorage.getItem('lopatcong-games'), visibleId: savedGames[0]?.id, cardStatus: document.querySelector('.game-card p')?.textContent, status: document.getElementById('syncStatus').textContent };
  });
  assert.ok(actual.injected > 0, 'the cloud-cache write failure must be exercised');
  assert.equal(actual.stored, null, 'the report is visible in memory but was not persisted');
  assert.equal(actual.visibleId, 'synthetic-uncached-cloud');
  assert.equal(await page.locator('.game-card').count(), 1);
  assert.match(actual.cardStatus, /awaiting cloud confirmation/i);
  assert.doesNotMatch(actual.cardStatus, /cached|saved locally|saved on this device/i, 'a report whose storage write failed must not claim a local cache');
  assert.match(actual.status, /not be saved|could not save|storage|recover/i);
});
