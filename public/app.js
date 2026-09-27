'use strict';

/* ------------------------------------------------------------------
   Stat model
   Each button logs one event. Events roll up into totals, so a goal
   also counts as a shot on goal, a shot and a touch. Press only the
   most specific button.
------------------------------------------------------------------- */

// DualSense in the W3C "standard" gamepad mapping (what Safari exposes)
const BTN = {
  CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3,
  L1: 4, R1: 5, L2: 6, R2: 7,
  CREATE: 8, OPTIONS: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

const EVENTS = {
  pass:   { label: 'Pass',         btn: BTN.CROSS,    key: '1', counts: ['pass', 'touch'] },
  touch:  { label: 'Touch',        btn: BTN.CIRCLE,   key: '2', counts: ['touch'] },
  tackle: { label: 'Tackle',       btn: BTN.SQUARE,   key: '3', counts: ['tackle', 'touch'] },
  shot:   { label: 'Shot',         btn: BTN.TRIANGLE, key: '4', counts: ['shot', 'touch'] },
  onGoal: { label: 'Shot on goal', btn: BTN.R1,       key: '5', counts: ['onGoal', 'shot', 'touch'] },
  goal:   { label: 'Goal',         btn: BTN.R2,       key: '6', counts: ['goal', 'onGoal', 'shot', 'touch'] },
  assist: { label: 'Assist',       btn: BTN.L1,       key: '7', counts: ['assist', 'pass', 'touch'] },
};

// Tiles show totals, in the order of the on-screen grid
const TILES = [
  { total: 'pass',   label: 'Passes',       event: 'pass',   hint: 'Completed pass' },
  { total: 'touch',  label: 'Touches',      event: 'touch',  hint: 'Any other touch' },
  { total: 'tackle', label: 'Tackles',      event: 'tackle', hint: 'Won the ball' },
  { total: 'shot',   label: 'Shots',        event: 'shot',   hint: 'Missed or blocked' },
  { total: 'onGoal', label: 'Shots on goal', event: 'onGoal', hint: 'Saved' },
  { total: 'goal',   label: 'Goals',        event: 'goal',   hint: 'Scored' },
  { total: 'assist', label: 'Assists',      event: 'assist', hint: 'Pass that led to a goal' },
];

const TOTAL_ORDER = ['goal', 'assist', 'shot', 'onGoal', 'pass', 'tackle', 'touch'];
const TOTAL_LABEL = Object.fromEntries(TILES.map(t => [t.total, t.label]));

const BTN_TO_EVENT = Object.fromEntries(Object.entries(EVENTS).map(([id, e]) => [e.btn, id]));
const KEY_TO_EVENT = Object.fromEntries(Object.entries(EVENTS).map(([id, e]) => [e.key, id]));

/* ------------------------------------------------------------------
   Storage (installed PWAs keep localStorage; data is tiny)
------------------------------------------------------------------- */

const STORE_KEY = 'sideline:v1';
const HALVES = 2;
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        current: foldExtraHalves(s.current || null),
        history: Array.isArray(s.history) ? s.history.map(foldExtraHalves) : [],
        prefs: s.prefs || {},
      };
    }
  } catch (e) { /* fall through */ }
  return { current: null, history: [], prefs: {} };
}

/*
  Football has two halves. Earlier builds let "end half" run again in the
  2nd half, which made a period 3 and beyond. Fold those back into the 2nd
  half, shifting their clock times on by the length of the periods before.
*/
function foldExtraHalves(m) {
  if (!m || !(m.period > HALVES)) return m;
  const ends = m.periodEnds || {};
  const offset = {};
  let acc = 0;
  for (let p = HALVES; p <= m.period; p++) {
    offset[p] = acc;
    acc += ends[p] || 0;
  }
  for (const list of [m.events, m.subs, m.score, m.redo]) {
    for (const x of list || []) {
      if (!(x.period > HALVES)) continue;
      x.ms += offset[x.period] || 0;
      x.period = HALVES;
    }
  }
  const ended = ends[m.period] != null;
  m.accMs = (m.accMs || 0) + offset[m.period];
  for (let p = HALVES; p <= m.period; p++) delete ends[p];
  if (ended) ends[HALVES] = acc;
  m.periodEnds = ends;
  m.period = HALVES;
  return m;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save. Storage is full or blocked.'); }
}

/* ------------------------------------------------------------------
   Match + clock
------------------------------------------------------------------- */

function newMatch({ player, team, opponent, startOnPitch }) {
  return {
    id: String(Date.now()),
    player: player.trim(),
    team: team.trim(),
    opponent: opponent.trim(),
    startedAt: new Date().toISOString(),
    period: 1,
    running: false,
    accMs: 0,         // elapsed in current period before the latest run
    runStart: 0,      // Date.now() when the clock last started
    periodEnds: {},   // period -> clock ms when it ended
    startOnPitch,
    onPitch: startOnPitch,
    events: [],       // { type, period, ms, at }
    subs: [],         // { on, period, ms, at }
    score: [],        // { side: 'us' | 'them', period, ms, at } (goals by others)
  };
}

function teamName(m) { return m.team || 'Us'; }
function oppName(m) { return m.opponent || 'Them'; }
function stamp(m) { return { period: m.period, ms: elapsedMs(m), at: Date.now() }; }

// His goals count toward the team score automatically
function scoreline(m) {
  const extra = side => (m.score || []).filter(s => s.side === side).length;
  return { us: totals(m.events).goal + extra('us'), them: extra('them') };
}
function resultWord(sc) { return sc.us > sc.them ? 'Won' : sc.us < sc.them ? 'Lost' : 'Drew'; }

// Minutes on the pitch, per period and total. null if older data lacks period lengths.
function minutesOn(m) {
  const subs = (m.subs || []).slice().sort((a, b) => a.at - b.at);
  let on = m.startOnPitch !== false;
  let total = 0;
  const per = {};
  for (let p = 1; p <= m.period; p++) {
    const ends = m.periodEnds || {};
    const len = ends[p] != null ? ends[p] : (p === m.period ? elapsedMs(m) : null);
    if (len == null) return null;
    let cursor = 0, sum = 0;
    for (const sub of subs.filter(x => x.period === p)) {
      const at = Math.min(sub.ms, len);
      if (on) sum += at - cursor;
      cursor = at;
      on = sub.on;
    }
    if (on) sum += len - cursor;
    per[p] = sum;
    total += sum;
  }
  return { total, per };
}
function fmtMin(ms) { return ms == null ? '–' : String(Math.floor(ms / 60000)); }

function toggleOnPitch() {
  const m = state.current;
  if (!m) return;
  m.onPitch = !m.onPitch;
  m.subs = m.subs || [];
  m.subs.push({ on: m.onPitch, ...stamp(m) });
  save();
  renderLive();
  rumble(m.onPitch ? 'long' : 'triple');
  toast(m.onPitch ? 'On the pitch' : 'On the bench');
}

function addScore(side) {
  const m = state.current;
  if (!m) return;
  m.score = m.score || [];
  m.score.push({ side, ...stamp(m) });
  save();
  renderScore();
  renderLog();
}

function removeScore(side) {
  const m = state.current;
  if (!m || !m.score) return;
  for (let i = m.score.length - 1; i >= 0; i--) {
    if (m.score[i].side === side) { m.score.splice(i, 1); break; }
  }
  save();
  renderScore();
  renderLog();
}

function elapsedMs(m) {
  return m.accMs + (m.running ? Date.now() - m.runStart : 0);
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function periodLabel(p) { return p === 1 ? '1st half' : p === 2 ? '2nd half' : `Period ${p}`; }
function periodShort(p) { return p === 1 ? '1H' : p === 2 ? '2H' : `P${p}`; }

/*
  Options walks the match forward one step at a time, never back:
  kick off, half time, 2nd half kick off, full time. Undo steps back.
*/
function nextStep(m) {
  if (!m.running) return 'kickoff';
  return m.period < HALVES ? 'halfTime' : 'fullTime';
}
function stepLabel(m) {
  const k = nextStep(m);
  if (k === 'kickoff') return m.accMs ? 'Restart clock' : m.period === 1 ? 'Kick off' : 'Kick off 2nd half';
  return k === 'halfTime' ? 'Half time' : 'Full time';
}
function clockState(m) {
  return { period: m.period, running: m.running, accMs: m.accMs, runStart: m.runStart, periodEnds: { ...(m.periodEnds || {}) } };
}

function advanceMatch() {
  const m = state.current;
  if (!m) return;
  const kind = nextStep(m);
  if (kind === 'fullTime') { rumble('long'); return endMatch(); }
  const prev = clockState(m);
  if (kind === 'kickoff') {
    m.runStart = Date.now();
    m.running = true;
  } else {
    (m.periodEnds = m.periodEnds || {})[m.period] = elapsedMs(m);
    m.accMs = 0;
    m.running = false;
    m.period += 1;
  }
  (m.steps = m.steps || []).push({ kind, at: Date.now(), prev, next: clockState(m) });
  m.redo = [];
  save();
  renderLive();
  rumble(kind === 'halfTime' ? 'long' : 'tap');
  toast(kind === 'halfTime' ? 'Half time. Press Options at the 2nd half kick off.' : `${periodLabel(m.period)} kicked off`);
}

const STEP_NAME = { kickoff: 'kick off', halfTime: 'half time' };

// Full time can be undone from the summary straight after, back into the 2nd half
let justEnded = null;

function endMatch() {
  const m = state.current;
  if (!m) return;
  justEnded = { id: m.id, prev: clockState(m) };
  m.accMs = elapsedMs(m);
  m.running = false;
  (m.periodEnds = m.periodEnds || {})[m.period] = m.accMs;
  delete m.redo;
  delete m.steps;
  state.history.push(m);
  state.current = null;
  save();
  releaseAwake();
  showSummary(m);
}

function resetMatch() {
  const m = state.current;
  if (!m) return;
  m.events = [];
  m.redo = [];
  m.steps = [];
  m.subs = [];
  m.score = [];
  m.periodEnds = {};
  m.onPitch = m.startOnPitch !== false;
  m.period = 1;
  m.accMs = 0;
  m.running = false;
  save();
  renderLive();
  toast('Stats and clock reset');
}

function totals(events, period) {
  const t = Object.fromEntries(TOTAL_ORDER.map(k => [k, 0]));
  for (const ev of events) {
    if (period && ev.period !== period) continue;
    for (const k of EVENTS[ev.type].counts) t[k] += 1;
  }
  return t;
}

/* ------------------------------------------------------------------
   Logging events
------------------------------------------------------------------- */

function logEvent(type) {
  const m = state.current;
  if (!m) return;
  if (m.onPitch === false) {
    rumble('reject');
    toast('On the bench. Press d-pad left when he comes on.');
    return;
  }
  m.events.push({ type, period: m.period, ms: elapsedMs(m), at: Date.now() });
  m.redo = []; // a new stat ends the redo chain
  save();
  renderCounts();
  renderLog();
  for (const k of EVENTS[type].counts) flash(k);
  rumble(type === 'goal' ? 'long' : 'tap');
}

function reopenMatch() {
  const i = justEnded ? state.history.findIndex(m => m.id === justEnded.id) : -1;
  if (i < 0 || state.current) { rumble('double'); return; }
  const [m] = state.history.splice(i, 1);
  Object.assign(m, justEnded.prev, { redo: [], steps: [] });
  justEnded = null;
  state.current = m;
  save();
  renderLive();
  show('live');
  keepAwake();
  rumble('double');
  toast(`Back to the ${periodLabel(m.period).toLowerCase()}`);
}

// Undo walks back through stats and Options steps together, newest first
function undo() {
  const m = state.current;
  const step = m && m.steps && m.steps[m.steps.length - 1];
  const last = m && m.events[m.events.length - 1];
  if (step && step.at > (last ? last.at : 0)) {
    m.steps.pop();
    Object.assign(m, step.prev);
    (m.redo = m.redo || []).push({ step });
    save();
    renderLive();
    toast(`Undid ${STEP_NAME[step.kind]}`);
    rumble('double');
    return;
  }
  if (!m || !m.events.length) { rumble('double'); return; }
  const ev = m.events.pop();
  (m.redo = m.redo || []).push(ev);
  save();
  renderCounts();
  renderLog();
  flash(EVENTS[ev.type].counts[0]);
  toast(`Removed ${EVENTS[ev.type].label.toLowerCase()}`);
  rumble('double');
}

// Puts back the most recently undone stat, with its original time
function redo() {
  const m = state.current;
  if (!m || !m.redo || !m.redo.length) { rumble('double'); toast('Nothing to redo'); return; }
  const ev = m.redo.pop();
  if (ev.step) {
    Object.assign(m, ev.step.next);
    (m.steps = m.steps || []).push(ev.step);
    save();
    renderLive();
    toast(`Redid ${STEP_NAME[ev.step.kind]}`);
    rumble('tap');
    return;
  }
  m.events.push(ev);
  save();
  renderCounts();
  renderLog();
  for (const k of EVENTS[ev.type].counts) flash(k);
  toast(`Restored ${EVENTS[ev.type].label.toLowerCase()}`);
  rumble(ev.type === 'goal' ? 'long' : 'tap');
}

/* ------------------------------------------------------------------
   Controller input (Gamepad API, polled each frame)
------------------------------------------------------------------- */

let activePad = null;
const lastPressed = new Map(); // pad index -> boolean[]

function readPressed(gp, prev) {
  return gp.buttons.map((b, i) => {
    // Triggers are analog: require a firm pull, release lower to avoid chatter
    if (i === BTN.L2 || i === BTN.R2) return b.value > (prev[i] ? 0.3 : 0.6);
    return b.pressed;
  });
}

/*
  Polling runs on both requestAnimationFrame and a fast interval. iPadOS
  throttles rAF (Low Power Mode, busy frames), and a short press can fall
  between two frames. Edge detection is state-based, so double polling is safe.
*/
let resync = true; // after focus returns, adopt current button state without firing

function pollPads() {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  const found = pads[0] || null;
  if (!!found !== !!activePad) setPadStatus(!!found);
  activePad = found;

  const t = performance.now();
  if (!checkFocus(t)) return;

  for (const gp of pads) {
    const prev = lastPressed.get(gp.index) || [];
    const now = readPressed(gp, prev);
    if (!resync) {
      for (let i = 0; i < now.length; i++) {
        if (now[i] && !prev[i]) onButton(i);
      }
      if (gp === found) handleMatchButtons(now, t);
    }
    lastPressed.set(gp.index, now);
  }
  resync = false;
}

function rafLoop() { pollPads(); requestAnimationFrame(rafLoop); }

function onButton(i) {
  if (currentScreen === 'summary' && i === BTN.DOWN) return reopenMatch();
  if (!state.current || currentScreen !== 'live') return;
  if (i === BTN.OPTIONS) return advanceMatch();
  if (i in BTN_TO_EVENT) return logEvent(BTN_TO_EVENT[i]);
  if (i === BTN.DOWN) return undo();
  if (i === BTN.UP) return redo();
  if (i === BTN.LEFT) return toggleOnPitch();
}

/*
  Match controls avoid Create and PS: iPadOS uses those for screenshots,
  recordings and the system menu, which pull focus away from the app.
    press Options    next match step (see advanceMatch)
    hold R3          end match   (press right stick in)
    hold L3 + R3     reset match (press both sticks in)
*/
const TAP_MS = 400;
const HOLD_MS = 1500;
const RESET_MS = 2500;
const HOLDS = {
  endMatch: { label: 'Keep holding to end the match',   ms: HOLD_MS,  run: () => endMatch() },
  reset:    { label: 'Keep holding to reset all stats', ms: RESET_MS, run: () => resetMatch() },
};
const sys = { down: {}, combo: false, fired: false, ticked: false };

function handleMatchButtons(now, t) {
  const l3 = !!now[BTN.L3], r3 = !!now[BTN.R3];
  const live = state.current && currentScreen === 'live';

  for (const [b, p] of [[BTN.L3, l3], [BTN.R3, r3]]) {
    if (p && !sys.down[b]) sys.down[b] = t;
  }

  let action = null, since = 0;
  if (l3 && r3) { sys.combo = true; action = 'reset'; since = Math.max(sys.down[BTN.L3], sys.down[BTN.R3]); }
  else if (!sys.combo && r3) { action = 'endMatch'; since = sys.down[BTN.R3]; }

  if (!action && sys.ticked && !sys.fired) { hideHold(); sys.ticked = false; }

  if (live && action && !sys.fired) {
    const held = t - since;
    if (held > TAP_MS) {
      if (!sys.ticked) { sys.ticked = true; rumble('tick'); }
      showHold(HOLDS[action].label, held / HOLDS[action].ms);
    }
    if (held >= HOLDS[action].ms) {
      sys.fired = true;
      hideHold();
      rumble('long');
      HOLDS[action].run();
    }
  }

  if (!l3) sys.down[BTN.L3] = 0;
  if (!r3) sys.down[BTN.R3] = 0;
  if (!l3 && !r3) {
    if (!sys.fired && sys.ticked) hideHold();
    sys.combo = false; sys.fired = false; sys.ticked = false;
  }
}

function showHold(label, frac) {
  $('#hold-label').textContent = label;
  $('#hold-fill').style.width = `${Math.min(1, frac) * 100}%`;
  $('#hold').classList.add('show');
}
function hideHold() { $('#hold').classList.remove('show'); }

/*
  Safari only sends controller input to a focused page. If something else
  takes focus (address bar, a system banner), show a full-screen prompt and
  rumble so you notice, then resync button state when focus comes back.
*/
let focusLostAt = 0;
let focusWarned = false;

function hasFocus() { return document.visibilityState === 'visible' && document.hasFocus(); }

function checkFocus(t) {
  if (hasFocus()) {
    if (focusLostAt) {
      focusLostAt = 0;
      resync = true;
      if (focusWarned) { focusWarned = false; $('#paused').classList.remove('show'); rumble('tap'); }
    }
    return true;
  }
  if (!focusLostAt) focusLostAt = t;
  if (!focusWarned && currentScreen === 'live' && t - focusLostAt > 300) {
    focusWarned = true;
    hideHold();
    $('#paused').classList.add('show');
    rumble('lost');
  }
  return false;
}

function resumeFromPause() {
  window.focus();
  $('#paused').classList.remove('show');
  focusWarned = false;
  resync = true;
}

function rumble(kind) {
  const act = activePad && activePad.vibrationActuator;
  if (!act || typeof act.playEffect !== 'function') return;
  const pulse = (duration, mag) =>
    act.playEffect('dual-rumble', { duration, strongMagnitude: mag, weakMagnitude: mag }).catch(() => {});
  if (kind === 'long') pulse(350, 1);
  else if (kind === 'double') { pulse(60, 0.8); setTimeout(() => pulse(60, 0.8), 140); }
  else if (kind === 'tick') pulse(40, 0.3);
  else if (kind === 'triple') { pulse(60, 0.8); setTimeout(() => pulse(60, 0.8), 140); setTimeout(() => pulse(60, 0.8), 280); }
  else if (kind === 'reject') pulse(400, 1);
  else if (kind === 'lost') { pulse(500, 1); setTimeout(() => pulse(500, 1), 700); }
  else pulse(70, 0.6);
}

// Keyboard fallback for testing on a laptop
document.addEventListener('keydown', e => {
  if (currentScreen !== 'live' || e.target.tagName === 'INPUT') return;
  if (e.key in KEY_TO_EVENT) logEvent(KEY_TO_EVENT[e.key]);
  else if (e.key === 'Backspace' && e.shiftKey) redo();
  else if (e.key === 'b') toggleOnPitch();
  else if (e.key === 'Backspace') undo();
  else if (e.key === ' ') { e.preventDefault(); advanceMatch(); }
});

/* ------------------------------------------------------------------
   Rendering
------------------------------------------------------------------- */

const $ = sel => document.querySelector(sel);
let currentScreen = null;

const SHAPES = {
  [BTN.CROSS]:    ['g-cross',    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M4 4l12 12M16 4L4 16"/></svg>'],
  [BTN.CIRCLE]:   ['g-circle',   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.6"><circle cx="10" cy="10" r="7"/></svg>'],
  [BTN.SQUARE]:   ['g-square',   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.6"><rect x="3.5" y="3.5" width="13" height="13"/></svg>'],
  [BTN.TRIANGLE]: ['g-triangle', '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M10 3l8 13.5H2z"/></svg>'],
};
const SHOULDER = { [BTN.L1]: 'L1', [BTN.R1]: 'R1', [BTN.L2]: 'L2', [BTN.R2]: 'R2', [BTN.L3]: 'L3', [BTN.R3]: 'R3' };

const DPAD_OUTLINE = '<path d="M8.5 1h7v7.5H23v7h-7.5V23h-7v-7.5H1v-7h7.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity=".5"/>';
const DPAD_DOWN = `<svg viewBox="0 0 24 24" aria-hidden="true">${DPAD_OUTLINE}<path d="M8.5 15.5h7V23h-7z" fill="currentColor"/><path d="M10 17.5h4l-2 3z" fill="#1f5130"/></svg>`;
const DPAD_LEFT = `<svg viewBox="0 0 24 24" aria-hidden="true">${DPAD_OUTLINE}<path d="M1 8.5h7.5v7H1z" fill="currentColor"/><path d="M6.5 10v4l-3-2z" fill="#1f5130"/></svg>`;
const DPAD_UP = `<svg viewBox="0 0 24 24" aria-hidden="true">${DPAD_OUTLINE}<path d="M8.5 1h7v7.5h-7z" fill="currentColor"/><path d="M10 6.5h4l-2-3z" fill="#1f5130"/></svg>`;

function glyph(btn) {
  if (btn === BTN.DOWN) return `<span class="glyph dpad" aria-hidden="true">${DPAD_DOWN}</span>`;
  if (btn === BTN.UP) return `<span class="glyph dpad" aria-hidden="true">${DPAD_UP}</span>`;
  if (btn === BTN.LEFT) return `<span class="glyph dpad" aria-hidden="true">${DPAD_LEFT}</span>`;
  if (btn === BTN.OPTIONS) return '<span class="glyph shoulder word" aria-hidden="true">Options</span>';
  if (SHAPES[btn]) return `<span class="glyph ${SHAPES[btn][0]}" aria-hidden="true">${SHAPES[btn][1]}</span>`;
  if (SHOULDER[btn]) return `<span class="glyph shoulder" aria-hidden="true">${SHOULDER[btn]}</span>`;
  return '';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function show(name) {
  currentScreen = name;
  if (name !== 'summary') justEnded = null;
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== `screen-${name}`;
  window.scrollTo(0, 0);
  renderUpdateUI();
}

function buildLegend() {
  const rows = TILES.map(t => {
    const e = EVENTS[t.event];
    return `<dt>${glyph(e.btn)}</dt><dd>${t.label} <small>${t.hint.toLowerCase()}</small></dd>`;
  }).join('');
  $('#legend').innerHTML = `
    <h3>Stats</h3>
    <dl>
      ${rows}
      <dt>${glyph(BTN.DOWN)}</dt><dd>Undo <small>d-pad down arrow, last stat or Options step</small></dd>
      <dt>${glyph(BTN.UP)}</dt><dd>Redo <small>d-pad up arrow</small></dd>
    </dl>
    <p class="note">Press only the most specific button. A goal also counts as a shot on goal, a shot and a touch. An assist also counts as a pass.</p>
    <h3 class="legend-sub">Match</h3>
    <dl>
      <dt>${glyph(BTN.LEFT)}</dt><dd>Came on or went off <small>d-pad left arrow</small></dd>
      <dt>${glyph(BTN.OPTIONS)}</dt><dd>Next step <small>press: kick off, half time, 2nd half kick off, full time</small></dd>
      <dt>${glyph(BTN.R3)}</dt><dd>End match <small>press right stick in, hold 1.5 s</small></dd>
      <dt><span class="combo">${glyph(BTN.L3)}+${glyph(BTN.R3)}</span></dt><dd>Reset stats and clock <small>press both sticks in, hold 2.5 s</small></dd>
    </dl>
    <p class="note">Options is the small button to the right of the touchpad. Avoid Create and PS during a match; iPadOS uses them for screenshots and menus.</p>`;
}

function buildGrid() {
  $('#grid').innerHTML = TILES.map(t => `
    <button class="tile" data-total="${t.total}" data-event="${t.event}">
      <div class="tile-top">
        <span class="tile-label">${t.label}</span>
        ${glyph(EVENTS[t.event].btn)}
      </div>
      <span class="tile-count" data-count="${t.total}">0</span>
      <span class="tile-hint">${t.hint}</span>
    </button>`).join('') + `
    <section class="log" aria-label="Recent">
      <div class="log-head"><span>Recent</span></div>
      <ol id="log"></ol>
      <div class="log-actions"><button class="ghost undo" id="btn-undo">${glyph(BTN.DOWN)}Undo</button><button class="ghost undo" id="btn-redo">${glyph(BTN.UP)}Redo</button></div>
    </section>
    <div class="bench-banner" aria-live="polite"><strong>On the bench</strong><span>Press ${glyph(BTN.LEFT)} when he comes on</span></div>`;

  for (const tile of document.querySelectorAll('.tile')) {
    tile.addEventListener('click', () => logEvent(tile.dataset.event));
  }
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
}

function renderCounts() {
  const t = totals(state.current.events);
  for (const el of document.querySelectorAll('[data-count]')) el.textContent = t[el.dataset.count];
}

function renderScore() {
  const m = state.current;
  const sc = scoreline(m);
  $('#score-us').textContent = sc.us;
  $('#score-them').textContent = sc.them;
  $('#sheet-us-name').textContent = teamName(m);
  $('#sheet-them-name').textContent = oppName(m);
  $('#sheet-us').textContent = sc.us;
  $('#sheet-them').textContent = sc.them;
  $('#sheet-his').textContent = totals(m.events).goal;
}

// Stats, subs and team goals in the order they happened
function timeline(m, short) {
  const us = short ? 'Team goal' : `${teamName(m)} goal`;
  const them = short ? 'Conceded' : `${oppName(m)} goal`;
  const items = [
    ...m.events.map(e => ({ ...e, label: EVENTS[e.type].label, big: e.type === 'goal' || e.type === 'assist' })),
    ...(m.subs || []).map(x => ({ ...x, label: x.on ? 'Came on' : 'Went off', sub: true })),
    ...(m.score || []).map(x => ({ ...x, label: x.side === 'us' ? us : them, team: true })),
  ];
  return items.sort((a, b) => a.at - b.at);
}

function timelineItem(it) {
  const cls = it.big ? 'big' : it.sub || it.team ? 'aside' : '';
  return `<li class="${cls}"><time>${periodShort(it.period)} ${fmtClock(it.ms)}</time><span>${esc(it.label)}</span></li>`;
}

function renderLog() {
  const items = timeline(state.current, true).slice(-7).reverse();
  $('#log').innerHTML = items.length
    ? items.map(timelineItem).join('')
    : `<li class="empty">Press a controller button to log a stat. Press Options at kick off.</li>`;
}

function renderClock() {
  const m = state.current;
  if (!m) return;
  $('#clock').textContent = fmtClock(elapsedMs(m));
  $('#period').textContent = periodLabel(m.period);
  $('#clock-wrap').classList.toggle('paused', !m.running);
  const mins = minutesOn(m);
  const pill = $('#pitch-pill');
  pill.classList.toggle('off', m.onPitch === false);
  $('#pitch-state').textContent = m.onPitch === false ? 'On bench' : 'On pitch';
  $('#pitch-mins').textContent = `${fmtMin(mins && mins.total)} min played`;
  $('#btn-clock-label').textContent = stepLabel(m);
}

function renderLive() {
  const m = state.current;
  for (const t of document.querySelectorAll('.tile.hit')) t.classList.remove('hit');
  $('#live-vs').textContent = `${teamName(m)} vs ${oppName(m)}`;
  $('#grid').classList.toggle('bench', m.onPitch === false);
  renderScore();
  renderCounts();
  renderLog();
  renderClock();
}

function flash(total) {
  const tile = document.querySelector(`.tile[data-total="${total}"]`);
  if (!tile) return;
  tile.classList.remove('hit');
  void tile.offsetWidth; // restart animation
  tile.classList.add('hit');
}
for (const type of ['animationend', 'animationcancel']) {
  document.addEventListener(type, e => { if (e.animationName === 'hit') e.target.classList.remove('hit'); });
}

function setPadStatus(on) {
  for (const el of document.querySelectorAll('[data-pad-status]')) {
    el.textContent = on ? 'Controller connected' : 'Press any button on the controller to connect it';
    el.classList.toggle('on', on);
  }
  for (const el of document.querySelectorAll('[data-pad-dot]')) el.classList.toggle('on', on);
  if (currentScreen === 'live') toast(on ? 'Controller connected' : 'Controller disconnected');
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ------------------------------------------------------------------
   Summary + history
------------------------------------------------------------------- */

let viewing = null; // match shown on summary screen

function matchTitle(m) { return m.opponent ? `vs ${m.opponent}` : 'Match'; }
function matchDate(m) {
  return new Date(m.startedAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function showSummary(m) {
  viewing = m;
  const sc = scoreline(m);
  $('#sum-title').textContent = m.player ? `${m.player} vs ${oppName(m)}` : matchTitle(m);
  $('#sum-date').textContent = `${resultWord(sc)} ${sc.us}–${sc.them}, ${matchDate(m)}`;

  const periods = Array.from({ length: m.period }, (_, i) => i + 1);
  const mins = minutesOn(m);
  const all = totals(m.events);
  const per = periods.map(p => totals(m.events, p));
  const head = `<thead><tr><th>Stat</th>${periods.map(p => `<th>${periodShort(p)}</th>`).join('')}<th>Total</th></tr></thead>`;
  const rows = TOTAL_ORDER.map(k =>
    `<tr><td>${TOTAL_LABEL[k]}</td>${per.map(t => `<td>${t[k]}</td>`).join('')}<td class="total">${all[k]}</td></tr>`
  ).join('');
  const onTarget = all.shot ? Math.round((all.onGoal / all.shot) * 100) + '%' : '–';
  const conversion = all.shot ? Math.round((all.goal / all.shot) * 100) + '%' : '–';
  const span = periods.length;
  const minutesRow = `<tr><td>Minutes played</td>${periods.map(p => `<td>${fmtMin(mins && mins.per[p])}</td>`).join('')}<td class="total">${fmtMin(mins && mins.total)}</td></tr>`;
  const derived = minutesRow + `
    <tr class="derived"><td>Shots on target</td>${'<td></td>'.repeat(span)}<td>${onTarget}</td></tr>
    <tr class="derived"><td>Shots scored</td>${'<td></td>'.repeat(span)}<td>${conversion}</td></tr>`;
  $('#sum-table').innerHTML = head + `<tbody>${rows}${derived}</tbody>`;

  const items = timeline(m);
  $('#sum-timeline').innerHTML = items.length
    ? items.map(timelineItem).join('')
    : `<li class="empty">No stats were logged in this match.</li>`;

  show('summary');
}

function showHistory() {
  const list = $('#history-list');
  if (!state.history.length) {
    list.innerHTML = `<li class="empty">Finished matches show up here.</li>`;
  } else {
    list.innerHTML = state.history.slice().reverse().map(m => {
      const t = totals(m.events);
      const sc = scoreline(m);
      return `<li><button data-id="${m.id}">
        <span><span class="h-name">${esc(matchTitle(m))}</span><br><span class="h-date">${resultWord(sc)} ${sc.us}–${sc.them}, ${matchDate(m)}</span></span>
        <span class="h-line">${t.goal} G  ${t.assist} A  ${t.shot} shots  ${t.pass} passes</span>
      </button></li>`;
    }).join('');
    for (const b of list.querySelectorAll('button')) {
      b.addEventListener('click', () => showSummary(state.history.find(m => m.id === b.dataset.id)));
    }
  }
  show('history');
}

function toCSV(m) {
  const q = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const t = totals(m.events);
  const sc = scoreline(m);
  const mins = minutesOn(m);
  const lines = [
    ['Player', m.player || ''], ['Match', `${teamName(m)} vs ${oppName(m)}`], ['Date', matchDate(m)],
    ['Score', `${sc.us}-${sc.them}`], ['Result', resultWord(sc)], [],
    ['Stat', 'Total'], ...TOTAL_ORDER.map(k => [TOTAL_LABEL[k], t[k]]),
    ['Minutes played', fmtMin(mins && mins.total)], [],
    ['Period', 'Clock', 'Event', 'Counts toward'],
    ...timeline(m).map(it => [periodShort(it.period), fmtClock(it.ms), it.label,
      it.type ? EVENTS[it.type].counts.map(k => TOTAL_LABEL[k]).join('; ') : '']),
  ];
  return lines.map(r => r.map(v => q(String(v))).join(',')).join('\n');
}

function fileBase(m) {
  return `${(m.opponent || 'match').replace(/[^\w-]+/g, '-').toLowerCase()}-${m.startedAt.slice(0, 10)}`;
}

// Share sheet on iPad (Save to Files, Messages, WhatsApp...), download elsewhere
async function shareFile(file) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportCSV(m) {
  return shareFile(new File([toCSV(m)], `${fileBase(m)}.csv`, { type: 'text/csv' }));
}

/* ------------------------------------------------------------------
   Shareable summary card (PNG drawn on a canvas)
------------------------------------------------------------------- */

function roundRect(x, px, py, w, h, r) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

function drawCard(m) {
  const W = 1080, H = 1350, pad = 80;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const F = '"Avenir Next Condensed", "Avenir Next", "Arial Narrow", "Helvetica Neue", sans-serif';
  const chalk = '#f3f6ef', dim = 'rgba(243,246,239,0.66)', line = 'rgba(243,246,239,0.3)';

  for (let i = 0; i < 8; i++) {
    x.fillStyle = i % 2 ? '#1a4629' : '#1f5130';
    x.fillRect(i * W / 8, 0, W / 8 + 1, H);
  }
  x.strokeStyle = 'rgba(243,246,239,0.14)';
  x.lineWidth = 8;
  x.beginPath(); x.arc(W, 0, 330, 0, Math.PI * 2); x.stroke();

  const t = totals(m.events);
  const sc = scoreline(m);
  const mins = minutesOn(m);

  x.fillStyle = chalk;
  x.font = `800 112px ${F}`;
  x.fillText(m.player || 'Match stats', pad, 190, W - pad * 2);
  x.fillStyle = dim;
  x.font = `600 44px ${F}`;
  x.fillText(`${teamName(m)} vs ${oppName(m)}`, pad, 262, W - pad * 2);
  x.fillText(matchDate(m), pad, 318, W - pad * 2);

  x.fillStyle = chalk;
  x.font = `800 200px ${F}`;
  const scoreText = `${sc.us}–${sc.them}`;
  x.fillText(scoreText, pad, 540);
  const sw = x.measureText(scoreText).width;
  x.font = `700 64px ${F}`;
  x.fillText(resultWord(sc), pad + sw + 36, 540);

  const stats = [
    ['Goals', t.goal], ['Assists', t.assist],
    ['Shots', t.shot], ['Shots on goal', t.onGoal],
    ['Passes', t.pass], ['Tackles', t.tackle],
    ['Touches', t.touch], ['Minutes', fmtMin(mins && mins.total)],
  ];
  const gap = 24, cols = 2, bw = (W - pad * 2 - gap) / cols, bh = 150, top = 588;
  stats.forEach(([label, val], i) => {
    const bx = pad + (i % cols) * (bw + gap);
    const by = top + Math.floor(i / cols) * (bh + gap);
    x.fillStyle = 'rgba(6,28,14,0.34)';
    roundRect(x, bx, by, bw, bh, 22); x.fill();
    x.strokeStyle = line; x.lineWidth = 3; x.stroke();
    x.fillStyle = dim;
    x.font = `600 38px ${F}`;
    x.fillText(label, bx + 30, by + 60);
    x.fillStyle = chalk;
    x.font = `800 96px ${F}`;
    const vw = x.measureText(String(val)).width;
    x.fillText(String(val), bx + bw - 30 - vw, by + bh - 34);
  });

  x.fillStyle = dim;
  x.font = `600 34px ${F}`;
  x.fillText('Logged with Sideline', pad, H - 38);
  return c;
}

function shareCard(m) {
  drawCard(m).toBlob(blob => {
    if (!blob) return toast('Could not create the image.');
    shareFile(new File([blob], `${fileBase(m)}.png`, { type: 'image/png' }));
  }, 'image/png');
}

/* ------------------------------------------------------------------
   Backup and restore (all finished matches as one JSON file)
------------------------------------------------------------------- */

function backupAll() {
  if (!state.history.length) return toast('No finished matches to back up yet.');
  const data = { app: 'sideline', version: 1, exportedAt: new Date().toISOString(), history: state.history };
  const name = `sideline-backup-${new Date().toISOString().slice(0, 10)}.json`;
  shareFile(new File([JSON.stringify(data)], name, { type: 'application/json' }));
}

async function restoreFrom(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { return toast('That file is not a Sideline backup.'); }
  if (!data || data.app !== 'sideline' || !Array.isArray(data.history)) {
    return toast('That file is not a Sideline backup.');
  }
  const have = new Set(state.history.map(m => m.id));
  const incoming = data.history.filter(m => m && m.id && Array.isArray(m.events) && !have.has(m.id)).map(foldExtraHalves);
  state.history.push(...incoming);
  state.history.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  save();
  const skipped = data.history.length - incoming.length;
  toast(`Restored ${incoming.length} match${incoming.length === 1 ? '' : 'es'}${skipped ? `, ${skipped} already here` : ''}`);
  showHistory();
}

/* ------------------------------------------------------------------
   Keep the screen awake during a match
------------------------------------------------------------------- */

let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* not supported or denied */ }
}
function releaseAwake() { if (wakeLock) wakeLock.release().catch(() => {}); }
document.addEventListener('visibilitychange', () => { if (state.current) keepAwake(); });

/* ------------------------------------------------------------------
   Wiring
------------------------------------------------------------------- */

$('#player').value = state.prefs.player || '';
$('#team').value = state.prefs.team || '';

$('#btn-new').addEventListener('click', () => {
  const player = $('#player').value, team = $('#team').value;
  state.prefs = { player: player.trim(), team: team.trim() };
  state.current = newMatch({ player, team, opponent: $('#opponent').value, startOnPitch: !$('#bench').checked });
  save();
  $('#opponent').value = '';
  $('#bench').checked = false;
  renderLive();
  show('live');
  keepAwake();
});

$('#btn-clock').addEventListener('click', () => {
  const m = state.current;
  if (nextStep(m) === 'fullTime' && !confirm('Full time: end the match and save it?')) return;
  advanceMatch();
});
$('#btn-end').addEventListener('click', () => {
  if (confirm('End the match and save it?')) endMatch();
});
$('#btn-reset').addEventListener('click', () => {
  if (confirm('Reset all stats and the clock for this match?')) resetMatch();
});

$('#btn-done').addEventListener('click', () => show('setup'));
$('#btn-export').addEventListener('click', () => viewing && exportCSV(viewing));
$('#btn-card').addEventListener('click', () => viewing && shareCard(viewing));
$('#btn-backup').addEventListener('click', backupAll);
$('#btn-restore').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) restoreFrom(f);
});

$('#pitch-pill').addEventListener('click', toggleOnPitch);
$('#btn-score').addEventListener('click', () => { renderScore(); $('#score-sheet').classList.add('show'); });
$('#sheet-done').addEventListener('click', () => $('#score-sheet').classList.remove('show'));
for (const b of document.querySelectorAll('[data-score]')) {
  b.addEventListener('click', () => {
    const [op, side] = b.dataset.score.split(':');
    op === 'add' ? addScore(side) : removeScore(side);
  });
}
$('#btn-delete').addEventListener('click', () => {
  if (!viewing || !confirm('Delete this match? This cannot be undone.')) return;
  state.history = state.history.filter(m => m.id !== viewing.id);
  save();
  viewing = null;
  showHistory();
});
$('#btn-history').addEventListener('click', showHistory);
$('#btn-history-back').addEventListener('click', () => show('setup'));

setInterval(() => { if (currentScreen === 'live') renderClock(); }, 250);


buildLegend();
buildGrid();
if (state.current) { renderLive(); show('live'); keepAwake(); }
else show('setup');
requestAnimationFrame(rafLoop);
setInterval(pollPads, 8);

window.addEventListener('blur', () => pollPads());
window.addEventListener('focus', () => pollPads());
$('#paused').addEventListener('click', resumeFromPause);

const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const touchDevice = navigator.maxTouchPoints > 1;
if (!standalone && touchDevice) $('#notice-tab').hidden = false;

/* ------------------------------------------------------------------
   Version label and updates
   A new deploy installs in the background and waits. The version label
   shows "update ready"; off the live screen a banner offers to update.
   Updating reloads the app; a match in progress carries on where it was.
------------------------------------------------------------------- */

var waitingWorker = null;
var waitingVersion = null;
var runningVersion = null;
var updateRequested = false;

function askVersion(worker) {
  return new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = e => resolve(e.data);
    worker.postMessage('version', [ch.port2]);
    setTimeout(() => resolve(null), 2000);
  });
}

function renderUpdateUI() {
  const label = $('#version');
  label.textContent = runningVersion
    ? (waitingWorker ? `${runningVersion}, update ready` : runningVersion)
    : (waitingWorker ? 'Update ready' : '');
  label.classList.toggle('ready', !!waitingWorker);
  $('#update-banner').hidden = !waitingWorker || currentScreen === 'live';
  $('#update-text').textContent = waitingVersion ? `Version ${waitingVersion} is ready.` : 'A new version is ready.';
}

async function onWaiting(worker) {
  waitingWorker = worker;
  waitingVersion = await askVersion(worker);
  renderUpdateUI();
}

function applyUpdate() {
  if (!waitingWorker) return;
  updateRequested = true;
  waitingWorker.postMessage('skipWaiting');
}

async function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  let reg;
  try { reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }); }
  catch (e) { return; }

  const refreshRunning = async () => {
    const c = navigator.serviceWorker.controller;
    if (c) { runningVersion = await askVersion(c); renderUpdateUI(); }
  };
  const watch = worker => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) onWaiting(worker);
    });
  };

  refreshRunning();
  if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
  watch(reg.installing);
  reg.addEventListener('updatefound', () => watch(reg.installing));

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
    else refreshRunning(); // first install just took over
  });

  // Home Screen apps resume instead of relaunching, so check on every return
  const check = () => reg.update().catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(check, 30 * 60 * 1000);
}

$('#version').addEventListener('click', applyUpdate);
$('#btn-update').addEventListener('click', applyUpdate);
window.addEventListener('load', setupUpdates);
