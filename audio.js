// Alarm sounds synthesised with Web Audio, so there are no audio files to load
// and nothing can fail to decode at 7am.
//
// Browsers only let audio start after a user gesture. Once the AudioContext has
// been resumed by a tap it stays usable for the life of the page, which is why
// the app asks for one tap ("arm") before bed.

let ctx = null;
let master = null;
let loop = null;

function context() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function isUnlocked() {
  return !!ctx && ctx.state === 'running';
}

export async function unlock() {
  const c = context();
  if (c.state !== 'running') {
    try { await c.resume(); } catch { /* not allowed yet */ }
  }
  // iOS needs something to actually play inside the gesture.
  const src = c.createBufferSource();
  src.buffer = c.createBuffer(1, 1, 22050);
  src.connect(c.destination);
  src.start(0);
  return c.state === 'running';
}

function tone(out, t, dur, freq, type = 'square', peak = 0.35) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.005);
  g.gain.setValueAtTime(peak, t + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return osc;
}

export const SOUNDS = {
  classic: {
    name: 'Classic beep',
    period: 1.0,
    play(out, t) {
      for (let i = 0; i < 4; i++) tone(out, t + i * 0.13, 0.08, 1760, 'square', 0.25);
    },
  },
  siren: {
    name: 'Siren',
    period: 1.2,
    play(out, t) {
      const osc = tone(out, t, 1.15, 600, 'sawtooth', 0.22);
      osc.frequency.linearRampToValueAtTime(1400, t + 0.55);
      osc.frequency.linearRampToValueAtTime(600, t + 1.15);
    },
  },
  chime: {
    name: 'Chime',
    period: 1.6,
    play(out, t) {
      [659.25, 830.61, 987.77, 1318.5].forEach((f, i) => {
        const s = t + i * 0.16;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = f;
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(0.5, s + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, s + 0.9);
        osc.connect(g).connect(out);
        osc.start(s);
        osc.stop(s + 0.95);
      });
    },
  },
};

/**
 * Start a looping alarm. Scheduling runs ~1.5s ahead so background-tab timer
 * throttling (timers clamped to ~1/s) doesn't leave gaps.
 */
export function startAlarm(soundId = 'classic', { vibrate = true } = {}) {
  stopAlarm();
  const c = context();
  const sound = SOUNDS[soundId] || SOUNDS.classic;
  const bus = c.createGain();
  bus.connect(master);
  master.gain.cancelScheduledValues(c.currentTime);
  master.gain.setValueAtTime(1, c.currentTime);

  let next = c.currentTime + 0.05;
  const pump = () => {
    while (next < c.currentTime + 1.5) {
      sound.play(bus, next);
      next += sound.period;
    }
  };
  pump();
  const timer = setInterval(pump, 250);

  let buzz = null;
  if (vibrate && navigator.vibrate) {
    const pattern = [600, 400, 600, 400];
    navigator.vibrate(pattern);
    buzz = setInterval(() => navigator.vibrate(pattern), 2000);
  }

  loop = { timer, buzz, bus };
}

export function setAlarmVolume(v) {
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), t, 0.15);
}

export function stopAlarm() {
  if (!loop) return;
  clearInterval(loop.timer);
  if (loop.buzz) clearInterval(loop.buzz);
  if (navigator.vibrate) navigator.vibrate(0);
  // Fade the bus out and detach it; already-scheduled notes die with it.
  const bus = loop.bus;
  const t = ctx.currentTime;
  bus.gain.setTargetAtTime(0, t, 0.03);
  setTimeout(() => bus.disconnect(), 300);
  loop = null;
}

export function isRinging() {
  return !!loop;
}

/** Short one-off preview for the alarm editor. */
export function preview(soundId) {
  if (loop) return;
  startAlarm(soundId, { vibrate: false });
  setTimeout(stopAlarm, 2200);
}

/** Pleasant little "done" jingle. */
export function success() {
  if (!ctx) return;
  const t = ctx.currentTime + 0.05;
  const bus = ctx.createGain();
  bus.gain.value = 0.6;
  bus.connect(master);
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setValueAtTime(1, ctx.currentTime);
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(bus, t + i * 0.11, 0.18, f, 'triangle', 0.4));
}
