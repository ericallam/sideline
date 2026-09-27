// Fake DualSense (standard mapping) plus a controllable clock and focus.
// Everything is driven from page.evaluate so tests read like controller use.
const BTN = {
  CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, L1: 4, R1: 5, L2: 6, R2: 7,
  CREATE: 8, OPTIONS: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

const MOCK = `
  window.__btns = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  window.__axes = [0, 0, 0, 0];
  navigator.getGamepads = () => [{ index: 0, mapping: 'standard', buttons: window.__btns, axes: window.__axes, vibrationActuator: null }];
  window.__set = (i, v) => { window.__btns[i] = { pressed: v, value: v ? 1 : 0 }; };
  window.__sleep = ms => new Promise(r => setTimeout(r, ms));
  window.__press = async (i, ms = 40) => { __set(i, true); await __sleep(ms); __set(i, false); await __sleep(60); };
  window.__offset = 0;
  const _now = Date.now; Date.now = () => _now() + window.__offset;
  window.__focus = true;
  const _hf = document.hasFocus.bind(document); document.hasFocus = () => window.__focus && _hf();
`;

async function openApp(page) {
  await page.addInitScript(MOCK);
  await page.goto('/');
  await page.waitForTimeout(200);
}

async function startMatch(page, { player = '', team = '', opponent = '', bench = false } = {}) {
  await page.fill('#player', player);
  await page.fill('#team', team);
  await page.fill('#opponent', opponent);
  if (bench) await page.check('#bench');
  await page.click('#btn-new');
}

const press = (page, btn, ms) => page.evaluate(([b, m]) => window.__press(b, m), [btn, ms ?? 40]);
const hold = (page, btns, ms) => page.evaluate(async ([bs, m]) => {
  bs.forEach(b => window.__set(b, true));
  await window.__sleep(m);
  bs.forEach(b => window.__set(b, false));
  await window.__sleep(80);
}, [btns, ms]);
const stick = (page, x, y) => page.evaluate(async ([x, y]) => {
  window.__axes[0] = x; window.__axes[1] = y;
  await window.__sleep(60);
}, [x, y]);
const advance = (page, minutes) => page.evaluate(m => { window.__offset += m * 60000; }, minutes);
const stored = page => page.evaluate(() => JSON.parse(localStorage['sideline:v1']));
const count = (page, total) => page.textContent(`[data-count="${total}"]`);

module.exports = { BTN, openApp, startMatch, press, hold, stick, advance, stored, count };
