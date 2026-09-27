const { test, expect } = require('@playwright/test');
const { BTN, openApp, startMatch, press, hold, stick, advance, stored, count } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('stats cascade: goal counts as shot on goal, shot and touch; assist as pass', async ({ page }) => {
  await startMatch(page);
  for (const b of [BTN.CROSS, BTN.CIRCLE, BTN.SQUARE, BTN.TRIANGLE, BTN.R1, BTN.R2, BTN.L1]) await press(page, b);
  expect(await count(page, 'pass')).toBe('2');
  expect(await count(page, 'touch')).toBe('7');
  expect(await count(page, 'shot')).toBe('3');
  expect(await count(page, 'onGoal')).toBe('2');
  expect(await count(page, 'goal')).toBe('1');
  expect(await count(page, 'assist')).toBe('1');
});

test('very short presses still register', async ({ page }) => {
  await startMatch(page);
  for (let i = 0; i < 5; i++) await press(page, BTN.CROSS, 20);
  expect(await count(page, 'pass')).toBe('5');
});

test('undo (d-pad down) and redo (d-pad up); a new stat clears redo', async ({ page }) => {
  await startMatch(page);
  await press(page, BTN.CROSS);
  await press(page, BTN.R2);
  await press(page, BTN.DOWN);
  expect(await count(page, 'goal')).toBe('0');
  await press(page, BTN.UP);
  expect(await count(page, 'goal')).toBe('1');
  await press(page, BTN.DOWN);
  await press(page, BTN.CIRCLE);
  await press(page, BTN.UP);
  expect(await count(page, 'goal')).toBe('0');
});

test('Options steps kick off, half time, 2nd half, full time; L3+R3 resets', async ({ page }) => {
  await startMatch(page);
  await press(page, BTN.OPTIONS);
  expect((await stored(page)).current.running).toBe(true);

  await press(page, BTN.CROSS);
  await hold(page, [BTN.L3, BTN.R3], 2700);
  let cur = (await stored(page)).current;
  expect(cur.events).toHaveLength(0);
  expect(cur.running).toBe(false);

  await press(page, BTN.OPTIONS); // kick off
  await press(page, BTN.OPTIONS); // half time
  cur = (await stored(page)).current;
  expect(cur.period).toBe(2);
  expect(cur.running).toBe(false);

  await hold(page, [BTN.OPTIONS], 1700); // a long press is still one step
  cur = (await stored(page)).current;
  expect(cur.period).toBe(2);
  expect(cur.running).toBe(true);

  await press(page, BTN.OPTIONS); // full time
  const st = await stored(page);
  expect(st.current).toBeNull();
  expect(st.history).toHaveLength(1);
  await expect(page.locator('#screen-summary')).toBeVisible();
});

test('undo steps back through Options steps, including full time', async ({ page }) => {
  await startMatch(page);
  await press(page, BTN.OPTIONS); // kick off
  await advance(page, 10);
  await press(page, BTN.CROSS);
  await press(page, BTN.OPTIONS); // half time, by mistake

  await press(page, BTN.DOWN);
  let cur = (await stored(page)).current;
  expect(cur.period).toBe(1);
  expect(cur.running).toBe(true);
  expect(cur.events).toHaveLength(1);
  await expect(page.locator('#clock')).toHaveText('10:00'); // as if never pressed

  await press(page, BTN.UP); // redo half time
  cur = (await stored(page)).current;
  expect(cur.period).toBe(2);
  expect(cur.running).toBe(false);

  await press(page, BTN.DOWN); // half time
  await press(page, BTN.DOWN); // then the pass
  cur = (await stored(page)).current;
  expect(cur.period).toBe(1);
  expect(cur.events).toHaveLength(0);

  await press(page, BTN.OPTIONS); // half time
  await press(page, BTN.OPTIONS); // 2nd half kick off
  await advance(page, 5);
  await press(page, BTN.OPTIONS); // full time
  await expect(page.locator('#screen-summary')).toBeVisible();

  await press(page, BTN.DOWN);
  await expect(page.locator('#screen-live')).toBeVisible();
  const st = await stored(page);
  expect(st.history).toHaveLength(0);
  expect(st.current.period).toBe(2);
  expect(st.current.running).toBe(true);
});

test('bench blocks stats; minutes played follow subs across halves', async ({ page }) => {
  await startMatch(page, { bench: true });
  await press(page, BTN.OPTIONS);
  await advance(page, 5);
  await press(page, BTN.CROSS);
  expect(await count(page, 'pass')).toBe('0');

  await press(page, BTN.LEFT); // on at 5'
  await press(page, BTN.CROSS);
  expect(await count(page, 'pass')).toBe('1');
  await advance(page, 20);
  await press(page, BTN.OPTIONS); // half ends at 25'
  await press(page, BTN.OPTIONS);
  await advance(page, 10);
  await press(page, BTN.LEFT); // off at 10' of 2H
  await advance(page, 15);
  await hold(page, [BTN.R3], 1700);

  const row = page.locator('#sum-table tr', { hasText: 'Minutes played' });
  await expect(row).toContainText('20');
  await expect(row).toContainText('10');
  await expect(row.locator('td.total')).toHaveText('30');
});

test('score: his goals count automatically, sheet adds others', async ({ page }) => {
  await startMatch(page, { team: 'Lions', opponent: 'Rovers' });
  await press(page, BTN.R2);
  await page.click('#btn-score');
  await page.click('[data-score="add:us"]');
  await page.click('[data-score="add:them"]');
  await page.click('#sheet-done');
  await expect(page.locator('#score-us')).toHaveText('2');
  await expect(page.locator('#score-them')).toHaveText('1');
});

test('losing focus pauses input and shows the prompt', async ({ page }) => {
  await startMatch(page);
  await page.evaluate(() => { window.__focus = false; });
  await page.waitForTimeout(500);
  await press(page, BTN.CROSS);
  await expect(page.locator('#paused')).toBeVisible();
  expect(await count(page, 'pass')).toBe('0');
  await page.evaluate(() => { window.__focus = true; });
  await page.waitForTimeout(100);
  await expect(page.locator('#paused')).toBeHidden();
  await press(page, BTN.CROSS);
  expect(await count(page, 'pass')).toBe('1');
});

test('backup and restore round-trip without duplicates', async ({ page }) => {
  await startMatch(page, { opponent: 'Rovers' });
  await press(page, BTN.CROSS);
  await hold(page, [BTN.R3], 1700);
  await page.click('#btn-done');
  await page.click('#btn-history');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-backup')]);
  const file = await download.path();

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#btn-history');
  await page.setInputFiles('#restore-file', file);
  await page.waitForTimeout(200);
  expect((await stored(page)).history).toHaveLength(1);
  await page.setInputFiles('#restore-file', file);
  await page.waitForTimeout(200);
  expect((await stored(page)).history).toHaveLength(1);
});

test('saved matches with a period 3 fold into the 2nd half', async ({ page }) => {
  const min = 60000, at = Date.now();
  const m = {
    id: '1', player: '', team: '', opponent: 'Lions', startedAt: new Date().toISOString(),
    period: 3, running: false, accMs: 5 * min, runStart: 0,
    periodEnds: { 1: 25 * min, 2: 2 * min, 3: 5 * min },
    startOnPitch: true, onPitch: true,
    events: [
      { type: 'pass', period: 1, ms: min, at },
      { type: 'pass', period: 2, ms: min, at: at + 1 },
      { type: 'pass', period: 3, ms: min, at: at + 2 },
    ],
    subs: [{ on: false, period: 3, ms: 0, at: at + 3 }, { on: true, period: 3, ms: min, at: at + 4 }],
    score: [],
  };
  await page.evaluate(m => localStorage.setItem('sideline:v1', JSON.stringify({ current: null, history: [m], prefs: {} })), m);
  await page.reload();

  const h = await page.evaluate(() => state.history[0]);
  expect(h.period).toBe(2);
  expect(h.periodEnds).toEqual({ 1: 25 * min, 2: 7 * min });
  expect(h.events.map(e => [e.period, e.ms])).toEqual([[1, min], [2, min], [2, 3 * min]]);
  expect(h.subs.map(s => [s.period, s.ms])).toEqual([[2, 2 * min], [2, 3 * min]]);
  expect(await page.evaluate(() => minutesOn(state.history[0]).total)).toBe(31 * min);
});

test('an assist adds a team goal; undo and redo move both', async ({ page }) => {
  await startMatch(page);
  await press(page, BTN.L1);
  await expect(page.locator('#score-us')).toHaveText('1');
  expect((await stored(page)).current.score).toHaveLength(1);

  await press(page, BTN.DOWN);
  await expect(page.locator('#score-us')).toHaveText('0');
  expect((await stored(page)).current.score).toHaveLength(0);

  await press(page, BTN.UP);
  await expect(page.locator('#score-us')).toHaveText('1');
  expect(await count(page, 'assist')).toBe('1');
});

test('left stick HUD: hold left or right and press cross for a team goal', async ({ page }) => {
  await startMatch(page, { team: 'Lions', opponent: 'Rovers' });
  await stick(page, -0.9, 0.2);
  await expect(page.locator('#hud')).toHaveClass(/show/);
  await expect(page.locator('.hud-half[data-side="us"]')).toHaveClass(/on/);
  await press(page, BTN.CROSS);
  await expect(page.locator('#score-us')).toHaveText('1');
  expect(await count(page, 'pass')).toBe('0'); // cross scored instead of logging a pass

  await press(page, BTN.CIRCLE); // other stats wait while the HUD is up
  expect(await count(page, 'touch')).toBe('0');

  await stick(page, 0.8, -0.3);
  await press(page, BTN.CROSS);
  await expect(page.locator('#score-them')).toHaveText('1');

  await stick(page, 0, -1); // straight up is neither side
  await press(page, BTN.CROSS);
  await expect(page.locator('#score-us')).toHaveText('1');
  await expect(page.locator('#score-them')).toHaveText('1');

  await stick(page, 0, 0);
  await expect(page.locator('#hud')).not.toHaveClass(/show/);
  await press(page, BTN.CROSS);
  expect(await count(page, 'pass')).toBe('1');
  expect((await stored(page)).current.score.map(x => x.side)).toEqual(['us', 'them']);
});

test('undo and redo include team goals, newest first', async ({ page }) => {
  await startMatch(page);
  await stick(page, 0.9, 0);
  await press(page, BTN.CROSS); // opponent goal
  await stick(page, 0, 0);
  await press(page, BTN.CROSS); // pass
  await page.click('#btn-score');
  await page.click('[data-score="add:us"]'); // teammate goal from the sheet
  await page.click('#sheet-done');
  await expect(page.locator('#score-us')).toHaveText('1');

  await press(page, BTN.DOWN); // teammate goal
  await expect(page.locator('#score-us')).toHaveText('0');
  expect(await count(page, 'pass')).toBe('1');
  await press(page, BTN.DOWN); // pass
  expect(await count(page, 'pass')).toBe('0');
  await press(page, BTN.DOWN); // opponent goal
  await expect(page.locator('#score-them')).toHaveText('0');

  await press(page, BTN.UP);
  await expect(page.locator('#score-them')).toHaveText('1');
  await press(page, BTN.UP);
  await press(page, BTN.UP);
  await expect(page.locator('#score-us')).toHaveText('1');
  expect(await count(page, 'pass')).toBe('1');
});

test('controls and help open from the live screen; a controller press closes them', async ({ page }) => {
  await startMatch(page);
  await page.click('#btn-help');
  await expect(page.locator('#help-sheet')).toHaveClass(/show/);
  await expect(page.locator('#help-legend')).toContainText('Team goals');

  await press(page, BTN.CROSS);
  await expect(page.locator('#help-sheet')).not.toHaveClass(/show/);
  expect(await count(page, 'pass')).toBe('1');

  await page.click('#btn-help');
  await page.click('#help-done');
  await expect(page.locator('#help-sheet')).not.toHaveClass(/show/);
});
