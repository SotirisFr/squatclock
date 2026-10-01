import {
  DIFFICULTY, GRACE_MS, describeDays, formatCountdown, loadAlarms, loadStats,
  newAlarm, nextFire, recordWin, saveAlarms, sortAlarms,
} from './store.js';
import * as audio from './audio.js';
import { SquatTracker, loadLandmarker } from './squat.js';

const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

let alarms = loadAlarms();
let ringing = null;     // { alarm, tracker, target, startedAt, lastRepAt }
let wakeLock = null;

// ---------------------------------------------------------------- screens

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'ring' || id === 'bedside') keepAwake();
  else if (id === 'home') releaseWake();
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* battery saver or unsupported */ }
}

function releaseWake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const active = document.querySelector('.screen.active')?.id;
    if (active === 'ring' || active === 'bedside') keepAwake();
    tick();
  }
});

// ---------------------------------------------------------------- arming

function refreshArmBanner() {
  $('#arm-banner').hidden = audio.isUnlocked();
}

// Any tap anywhere unlocks audio for the rest of the session. The banner is
// only hidden once the click has landed, so the layout doesn't shift mid-tap.
document.addEventListener('pointerdown', () => {
  if (!audio.isUnlocked()) audio.unlock();
}, { capture: true });
document.addEventListener('click', () => setTimeout(refreshArmBanner, 250));

$('#arm-banner').addEventListener('click', async () => {
  const ok = await audio.unlock();
  refreshArmBanner();
  toast(ok ? 'Alarms armed — sound is on' : 'Sound is still blocked by the browser');
});

// ---------------------------------------------------------------- setup checks

async function permissionState(name) {
  try {
    return (await navigator.permissions.query({ name })).state;
  } catch {
    return 'prompt';
  }
}

async function refreshSetup() {
  const cam = await permissionState('camera');
  const notify = 'Notification' in window ? Notification.permission : 'unsupported';
  const model = localStorage.getItem('squatclock.modelReady') === '1';
  const set = (key, state) => {
    const li = document.querySelector(`[data-check="${key}"]`);
    li.classList.toggle('ok', state === 'ok');
    li.classList.toggle('bad', state === 'bad');
  };
  set('camera', cam === 'granted' ? 'ok' : cam === 'denied' ? 'bad' : '');
  set('notify', notify === 'granted' || notify === 'unsupported' ? 'ok' : notify === 'denied' ? 'bad' : '');
  set('model', model ? 'ok' : '');
  const allOk = document.querySelectorAll('.checks li.ok').length === 3;
  $('#setup').hidden = allOk;
}

$('#setup').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-grant]');
  if (!btn) return;
  const kind = btn.dataset.grant;
  btn.disabled = true;
  try {
    if (kind === 'camera') {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
    } else if (kind === 'notify') {
      await Notification.requestPermission();
    } else if (kind === 'model') {
      btn.textContent = 'Downloading…';
      await loadLandmarker();
      localStorage.setItem('squatclock.modelReady', '1');
    }
  } catch (err) {
    toast(kind === 'camera' ? 'Camera access was blocked' : `Couldn't finish: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    if (kind === 'model') btn.textContent = 'Download';
    refreshSetup();
  }
});

// ---------------------------------------------------------------- alarm list

function persist() {
  saveAlarms(alarms);
  renderList();
  renderNext();
}

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function renderList() {
  const ul = $('#alarm-list');
  ul.replaceChildren(...sortAlarms(alarms).map((a) => {
    const li = document.createElement('li');
    li.className = `alarm${a.enabled ? '' : ' off'}`;
    li.innerHTML = `
      <button class="alarm-main">
        <div class="alarm-label"></div>
        <div class="alarm-time"></div>
        <div class="alarm-meta">
          <span class="alarm-days"></span>
          <span class="alarm-reps"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 9l6-6 6 6M6 15l6 6 6-6"/></svg><span></span></span>
        </div>
      </button>
      <label class="switch"><input type="checkbox" aria-label="Enabled"><span></span></label>`;
    const days = describeDays(a.days);
    li.querySelector('.alarm-main').setAttribute('aria-label', `Edit alarm ${a.time}, ${a.label || 'Alarm'}, ${days}, ${a.reps} squats`);
    li.querySelector('.alarm-label').textContent = a.label || 'Alarm';
    li.querySelector('.alarm-time').textContent = a.time;
    const daysEl = li.querySelector('.alarm-days');
    if (a.days.length) {
      // Monday-first row of day letters, with the active days lit up.
      daysEl.append(...[1, 2, 3, 4, 5, 6, 0].map((d) => {
        const i = document.createElement('i');
        i.textContent = DAY_LETTERS[d];
        if (a.days.includes(d)) i.className = 'on';
        return i;
      }));
    } else {
      daysEl.textContent = days;
      daysEl.classList.add('once');
    }
    li.querySelector('.alarm-reps > span').textContent = `${a.reps} squats`;
    const toggle = li.querySelector('input');
    toggle.checked = a.enabled;
    toggle.addEventListener('change', () => {
      a.enabled = toggle.checked;
      a.nextAt = a.enabled ? nextFire(a) : null;
      persist();
      if (a.enabled) toast(`Rings in ${formatCountdown(a.nextAt - Date.now())}`);
    });
    li.querySelector('.alarm-main').addEventListener('click', () => openEditor(a));
    return li;
  }));
}

function soonest() {
  return alarms.filter((a) => a.enabled && a.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0];
}

function renderNext() {
  const a = soonest();
  const el = $('#next-alarm');
  if (!a) {
    el.textContent = 'No alarms set';
    el.classList.remove('on');
    $('#bedside-next').textContent = 'No alarm set';
    return;
  }
  const text = `Next alarm ${a.time} · in ${formatCountdown(a.nextAt - Date.now())}`;
  el.textContent = text;
  el.classList.add('on');
  $('#bedside-next').textContent = text;
}

function renderStats() {
  const s = loadStats();
  const el = $('#stats');
  el.replaceChildren();
  if (!s.alarmsBeaten) return;
  el.innerHTML = `
    <span class="stat streak"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22c4 0 7-2.7 7-7 0-3.5-2.4-6.2-4-8-.4 2-1.4 3.4-3 4 0-3.4-1.6-6.4-4-9 .3 3.3-1 5.6-2.5 7.6C4.3 11.4 5 13 5 15c0 4.3 3 7 7 7Z"/></svg><b></b></span>
    <span class="stat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 9l6-6 6 6M6 15l6 6 6-6"/></svg><b></b></span>`;
  const [streak, total] = el.querySelectorAll('.stat');
  streak.querySelector('b').textContent = s.streak;
  streak.title = `${s.streak}-day streak`;
  total.querySelector('b').textContent = s.totalSquats;
  total.title = `${s.totalSquats} squats in total`;
  el.setAttribute('aria-label', `${s.streak}-day streak, ${s.totalSquats} squats`);
}

// ---------------------------------------------------------------- editor

const editor = $('#editor');
let editing = null;

function pressed(container, attr, value) {
  container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value))));
}

function openEditor(alarm) {
  editing = alarm ? { ...alarm, days: [...alarm.days] } : newAlarm();
  const isNew = !alarm;
  $('#editor-title').textContent = isNew ? 'New alarm' : 'Edit alarm';
  $('#f-time').value = editing.time;
  $('#f-label').value = editing.label;
  $('#f-reps').value = editing.reps;
  $('#f-reps').textContent = editing.reps;
  $('#f-sound').value = editing.sound;
  $('#f-days').querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(editing.days.includes(Number(b.dataset.day)))));
  pressed($('#f-difficulty'), 'level', editing.difficulty);
  $('#difficulty-hint').textContent = DIFFICULTY[editing.difficulty].hint;
  $('#delete-alarm').hidden = isNew;
  editor.showModal();
}

$('#f-sound').append(...Object.entries(audio.SOUNDS).map(([id, s]) => new Option(s.name, id)));

$('#f-days').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = Number(b.dataset.day);
  editing.days = editing.days.includes(d) ? editing.days.filter((x) => x !== d) : [...editing.days, d];
  b.setAttribute('aria-pressed', String(editing.days.includes(d)));
});

$('#f-difficulty').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  editing.difficulty = b.dataset.level;
  pressed($('#f-difficulty'), 'level', editing.difficulty);
  $('#difficulty-hint').textContent = DIFFICULTY[editing.difficulty].hint;
});

function setReps(n) {
  editing.reps = Math.max(1, Math.min(50, n));
  $('#f-reps').textContent = editing.reps;
}
$('#reps-dec').addEventListener('click', () => setReps(editing.reps - (editing.reps > 10 ? 5 : 1)));
$('#reps-inc').addEventListener('click', () => setReps(editing.reps + (editing.reps >= 10 ? 5 : 1)));

$('#preview-sound').addEventListener('click', async () => {
  await audio.unlock();
  audio.preview($('#f-sound').value);
});

$('#cancel-edit').addEventListener('click', () => editor.close());

$('#delete-alarm').addEventListener('click', () => {
  alarms = alarms.filter((a) => a.id !== editing.id);
  editor.close();
  persist();
  toast('Alarm deleted');
});

$('#editor-form').addEventListener('submit', (e) => {
  e.preventDefault();
  editing.time = $('#f-time').value || '07:00';
  editing.label = $('#f-label').value.trim();
  editing.sound = $('#f-sound').value;
  editing.enabled = true;
  editing.nextAt = nextFire(editing);
  const i = alarms.findIndex((a) => a.id === editing.id);
  if (i >= 0) alarms[i] = editing; else alarms.push(editing);
  editor.close();
  persist();
  audio.unlock().then(refreshArmBanner);
  toast(`Rings in ${formatCountdown(editing.nextAt - Date.now())} — do ${editing.reps} squats to stop it`);
});

$('#add-btn').addEventListener('click', () => openEditor(null));

// ---------------------------------------------------------------- clock + scheduler

function tick() {
  const now = new Date();
  const t = hhmm(now);
  $('#clock').textContent = t;
  $('#bedside-clock').textContent = t;
  $('#ring-time').textContent = t;
  $('#date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  let changed = false;
  for (const a of alarms) {
    if (!a.enabled || !a.nextAt || now.getTime() < a.nextAt) continue;
    const late = now.getTime() - a.nextAt;
    if (late <= GRACE_MS && !ringing) ring(a);
    if (a.days.length) {
      a.nextAt = nextFire(a, now);
    } else {
      a.enabled = false;
      a.nextAt = null;
    }
    changed = true;
  }
  if (changed) persist();
  else if (now.getSeconds() === 0) renderNext();
}

// ---------------------------------------------------------------- ringing

const CIRC = 2 * Math.PI * 52;

async function ring(alarm) {
  ringing = { alarm, tracker: null, target: alarm.reps, startedAt: Date.now(), lastRepAt: Date.now() };
  if (editor.open) editor.close();
  $('#ring-label').textContent = alarm.label || 'Wake up';
  $('#ring-target').textContent = alarm.reps;
  $('#rep-target').textContent = alarm.reps;
  $('#rep-count').textContent = '0';
  $('#progress-bar').style.strokeDashoffset = CIRC;
  $('#counter').dataset.reps = 0;
  $('#ring-intro').hidden = false;
  $('#counter').hidden = true;
  $('#meter').hidden = true;
  $('#cam-error').hidden = true;
  $('#start-squats').disabled = false;
  $('#start-squats').textContent = 'Start camera';
  $('#ring').classList.remove('tracking');
  show('ring');

  audio.startAlarm(alarm.sound);
  notifyIfHidden(alarm);

  // If the camera was already granted we can start without a tap.
  if ((await permissionState('camera')) === 'granted') startTracking();
}

async function notifyIfHidden(alarm) {
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.ready;
  reg?.showNotification('Alarm — time to squat!', {
    body: `${alarm.label || 'Wake up'} · ${alarm.reps} squats to stop it`,
    tag: 'squatclock-alarm',
    requireInteraction: true,
    renotify: true,
    vibrate: [600, 400, 600, 400, 600],
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
  });
}

$('#start-squats').addEventListener('click', async () => {
  await audio.unlock();
  // If the alarm fired before audio was unlocked, restart it now that it can play.
  if (ringing && !audio.isRinging()) audio.startAlarm(ringing.alarm.sound);
  refreshArmBanner();
  startTracking();
});

async function startTracking() {
  if (!ringing || ringing.tracker) return;
  const btn = $('#start-squats');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  const tracker = new SquatTracker({
    video: $('#cam'),
    canvas: $('#overlay'),
    level: ringing.alarm.difficulty,
    onFrame,
  });
  ringing.tracker = tracker;
  try {
    await tracker.start();
    localStorage.setItem('squatclock.modelReady', '1');
    $('#ring-intro').hidden = true;
    $('#counter').hidden = false;
    $('#meter').hidden = false;
    $('#ring').classList.add('tracking');
    setStatus('Step back so your whole body is in view');
  } catch (err) {
    tracker.stop();
    if (ringing) ringing.tracker = null;
    btn.disabled = false;
    btn.textContent = 'Try again';
    const msg = err?.name === 'NotAllowedError'
      ? 'Camera access is blocked. Allow it in your browser’s site settings.'
      : err?.name === 'NotFoundError'
        ? 'No camera found on this device.'
        : `Couldn't start the body tracker (${err?.message || err}). Check your connection the first time you use it.`;
    const e = $('#cam-error');
    e.textContent = msg;
    e.hidden = false;
  }
}

function setStatus(text) {
  const s = $('#status');
  if (s.textContent !== text) s.textContent = text;
}

function onFrame({ reps, depth, state, missing, event }) {
  if (!ringing) return;
  const now = Date.now();
  const { target } = ringing;

  $('#meter-fill').style.height = `${Math.round(depth * 100)}%`;
  $('#meter').classList.toggle('hit', state === 'down');

  if (missing === 'body') setStatus('Step into view');
  else if (missing === 'feet') setStatus('Step back — I need to see your feet');
  else if (missing === 'legs') setStatus('Step back so your whole body is in view');
  else if (state === 'down') setStatus('Now stand up!');
  else if (depth > 0.15) setStatus('Lower…');
  else setStatus(reps ? 'Keep going — squat!' : 'Squat down!');

  if (event === 'rep') {
    ringing.lastRepAt = now;
    $('#rep-count').textContent = reps;
    $('#progress-bar').style.strokeDashoffset = CIRC * (1 - Math.min(1, reps / target));
    const c = $('#counter');
    c.dataset.reps = reps;
    c.classList.remove('bump');
    void c.offsetWidth;
    c.classList.add('bump');
    if (reps >= target) return finish(reps);
  }

  // Each squat quiets the alarm a little; slacking off brings it back to full blast.
  const idle = now - ringing.lastRepAt > 15000;
  audio.setAlarmVolume(idle ? 1 : Math.max(0.2, 1 - 0.8 * (reps / target)));
}

function stopRinging() {
  audio.stopAlarm();
  ringing?.tracker?.stop();
  navigator.serviceWorker?.ready.then((reg) =>
    reg.getNotifications({ tag: 'squatclock-alarm' }).then((ns) => ns.forEach((n) => n.close())));
}

function finish(reps) {
  const r = ringing;
  stopRinging();
  ringing = null;
  audio.success();
  const stats = recordWin(reps);
  const h = new Date().getHours();
  $('#done-title').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#done-sub').textContent = `${reps} squats in ${Math.max(1, Math.round((Date.now() - r.startedAt) / 1000))} seconds. You're up.`;
  $('#done-streak').textContent = stats.streak;
  $('#done-total').textContent = stats.totalSquats;
  $('#done-beaten').textContent = stats.alarmsBeaten;
  renderStats();
  show('done');
}

$('#done-btn').addEventListener('click', () => show('home'));

// Emergency exit: hold for 10 seconds (injury, broken camera…).
{
  const btn = $('#escape');
  const fill = $('#escape-fill');
  const HOLD = 10000;
  let start = 0, raf = 0;
  const step = () => {
    const p = Math.min(1, (performance.now() - start) / HOLD);
    fill.style.width = `${p * 100}%`;
    if (p >= 1) {
      cancel();
      stopRinging();
      ringing = null;
      show('home');
      toast('Alarm stopped without squats');
      return;
    }
    raf = requestAnimationFrame(step);
  };
  const cancel = () => {
    cancelAnimationFrame(raf);
    fill.style.width = '0';
  };
  btn.addEventListener('pointerdown', (e) => {
    try { btn.setPointerCapture(e.pointerId); } catch { /* not a capturable pointer */ }
    start = performance.now();
    raf = requestAnimationFrame(step);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, cancel));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- test + bedside

$('#test-btn').addEventListener('click', async () => {
  await audio.unlock();
  refreshArmBanner();
  const now = new Date();
  ring({ ...newAlarm(), time: hhmm(now), label: 'Test alarm', reps: 3, sound: 'classic' });
});

$('#bedside-btn').addEventListener('click', async () => {
  await audio.unlock();
  refreshArmBanner();
  if (!soonest()) toast('No alarm is set — add one first');
  show('bedside');
  document.documentElement.requestFullscreen?.().catch(() => {});
});

// Double-tap to leave (dblclick isn't reliable on touch screens).
{
  let lastTap = 0;
  $('#bedside').addEventListener('pointerup', () => {
    const now = performance.now();
    if (now - lastTap < 400) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      show('home');
    }
    lastTap = now;
  });
}

// ---------------------------------------------------------------- service worker

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'notification-click' && ringing) show('ring');
  });
}

// ---------------------------------------------------------------- boot

// Recompute schedules on load: drop alarms that were missed while the app was closed.
{
  const now = Date.now();
  for (const a of alarms) {
    if (!a.enabled) continue;
    if (!a.nextAt || now - a.nextAt > GRACE_MS) {
      a.nextAt = a.days.length ? nextFire(a) : (a.nextAt ? null : nextFire(a));
      if (!a.nextAt) a.enabled = false;
    }
  }
  saveAlarms(alarms);
}

renderList();
renderNext();
renderStats();
refreshArmBanner();
refreshSetup();
tick();
setInterval(tick, 1000);
