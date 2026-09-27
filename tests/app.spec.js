const { test, expect } = require('@playwright/test');
const { BTN, openApp, startMatch, press, hold, advance, stored, count } = require('./helpers');

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

test('Options tap toggles clock; holds end half, end match; L3+R3 resets', async ({ page }) => {
  await startMatch(page);
  await press(page, BTN.OPTIONS);
  expect((await stored(page)).current.running).toBe(true);

  await press(page, BTN.CROSS);
  await hold(page, [BTN.L3, BTN.R3], 2700);
  let cur = (await stored(page)).current;
  expect(cur.events).toHaveLength(0);
  expect(cur.running).toBe(false);

  await hold(page, [BTN.OPTIONS], 1700);
  expect((await stored(page)).current.period).toBe(2);

  await hold(page, [BTN.R3], 1700);
  const st = await stored(page);
  expect(st.current).toBeNull();
  expect(st.history).toHaveLength(1);
  await expect(page.locator('#screen-summary')).toBeVisible();
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
  await hold(page, [BTN.OPTIONS], 1700); // half ends at 25'
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
