// Persistence + scheduling for alarms and stats. All state lives in localStorage.

const ALARMS_KEY = 'squatclock.alarms.v1';
const STATS_KEY = 'squatclock.stats.v1';

// If the app was asleep/throttled when an alarm was due, still ring it if we're
// at most this late. Anything later is considered missed and just rescheduled.
export const GRACE_MS = 10 * 60 * 1000;

export const DIFFICULTY = {
  easy:   { label: 'Easy',   hint: 'Half squat' },
  normal: { label: 'Normal', hint: 'Thighs near parallel' },
  deep:   { label: 'Deep',   hint: 'Below parallel' },
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — nothing sensible to do */
  }
}

export function newAlarm() {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    time: '07:00',
    label: '',
    days: [],            // 0 = Sunday … 6 = Saturday; empty = one-time
    reps: 10,
    difficulty: 'normal',
    sound: 'classic',
    enabled: true,
    nextAt: null,
  };
}

export function loadAlarms() {
  const alarms = read(ALARMS_KEY, []);
  return Array.isArray(alarms) ? alarms : [];
}

export function saveAlarms(alarms) {
  write(ALARMS_KEY, alarms);
}

/** Next timestamp (ms) strictly after `from` at which this alarm should ring. */
export function nextFire(alarm, from = new Date()) {
  const [h, m] = alarm.time.split(':').map(Number);
  for (let d = 0; d < 8; d++) {
    const c = new Date(from);
    c.setDate(c.getDate() + d);
    c.setHours(h, m, 0, 0);
    if (c <= from) continue;
    if (alarm.days.length && !alarm.days.includes(c.getDay())) continue;
    return c.getTime();
  }
  return null;
}

export function sortAlarms(alarms) {
  return [...alarms].sort((a, b) => a.time.localeCompare(b.time));
}

export function describeDays(days) {
  if (!days.length) return 'Once';
  if (days.length === 7) return 'Every day';
  const s = [...days].sort().join(',');
  if (s === '1,2,3,4,5') return 'Weekdays';
  if (s === '0,6') return 'Weekends';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Show Monday-first order, which is what people expect.
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => names[d]).join(' ');
}

export function formatCountdown(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

// ---- stats -----------------------------------------------------------------

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function loadStats() {
  return read(STATS_KEY, { totalSquats: 0, alarmsBeaten: 0, streak: 0, lastDay: null });
}

export function recordWin(squats) {
  const stats = loadStats();
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  if (stats.lastDay !== today) {
    stats.streak = stats.lastDay === yesterday ? stats.streak + 1 : 1;
    stats.lastDay = today;
  }
  stats.totalSquats += squats;
  stats.alarmsBeaten += 1;
  write(STATS_KEY, stats);
  return stats;
}
