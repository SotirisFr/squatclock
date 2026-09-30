// Simulates squats as pose landmarks and checks the rep counter.
// Usage: node tools/test-reps.mjs
import assert from 'node:assert/strict';
import { RepCounter, legMetrics } from '../squat.js';

const THIGH = 0.2, SHIN = 0.2;

/** Landmarks for a given knee angle (degrees), seen from the side or head-on. */
function pose(kneeDeg, view) {
  // Split the bend between shin (tilts forward) and thigh (tilts back) so the
  // angle at the knee is exactly kneeDeg. The thigh does most of the moving.
  const bend = (180 - kneeDeg) * (Math.PI / 180);
  const shinTilt = 0.35 * bend, thighTilt = 0.65 * bend;
  const ankle = { x: 0.5, y: 0.9, z: 0 };
  const knee = { x: ankle.x + SHIN * Math.sin(shinTilt), y: ankle.y - SHIN * Math.cos(shinTilt), z: 0 };
  const hip = { x: knee.x - THIGH * Math.sin(thighTilt), y: knee.y - THIGH * Math.cos(thighTilt), z: 0 };
  const world = [];
  const image = [];
  for (let i = 0; i < 33; i++) image[i] = { x: 0.5, y: 0.3, z: 0, visibility: 0.9 };
  const put = (arr, i, p) => { arr[i] = { ...p, visibility: 0.9 }; };
  for (const [h, k, a] of [[23, 25, 27], [24, 26, 28]]) {
    if (view === 'side') {
      put(image, h, hip); put(image, k, knee); put(image, a, ankle);
    } else {
      // Head-on: forward/back motion collapses into depth, only heights remain.
      put(image, h, { x: 0.5, y: hip.y }); put(image, k, { x: 0.5, y: knee.y }); put(image, a, { x: 0.5, y: ankle.y });
    }
    put(world, h, hip); put(world, k, knee); put(world, a, ankle);
  }
  return { image, world: view === 'front-noworld' ? null : world };
}

function run({ level, view, depthDeg, reps, fps = 30 }) {
  const c = new RepCounter(level);
  let t = 0;
  const frame = (deg) => {
    const { image, world } = pose(deg, view);
    const m = legMetrics(image, world);
    assert.ok(!m.missing, 'legs should be visible');
    c.update(m, t);
    t += 1000 / fps;
  };
  for (let i = 0; i < fps; i++) frame(175); // stand still for a second
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i <= fps; i++) frame(175 - (175 - depthDeg) * (i / fps)); // 1s down
    for (let i = 0; i <= fps; i++) frame(depthDeg + (175 - depthDeg) * (i / fps)); // 1s up
  }
  return c.reps;
}

const cases = [
  ['side view, normal, full squats', { level: 'normal', view: 'side', depthDeg: 80, reps: 5 }, 5],
  ['side view, normal, half squats do not count', { level: 'normal', view: 'side', depthDeg: 130, reps: 5 }, 0],
  ['side view, easy, half squats count', { level: 'easy', view: 'side', depthDeg: 115, reps: 5 }, 5],
  ['side view, deep, parallel is not enough', { level: 'deep', view: 'side', depthDeg: 100, reps: 3 }, 0],
  ['head-on with world landmarks', { level: 'normal', view: 'front', depthDeg: 80, reps: 4 }, 4],
  ['head-on, image only (hip-drop fallback)', { level: 'normal', view: 'front-noworld', depthDeg: 80, reps: 4 }, 4],
  ['head-on, image only, tiny dips do not count', { level: 'normal', view: 'front-noworld', depthDeg: 150, reps: 4 }, 0],
  ['head-on, image only, half squats do not count', { level: 'normal', view: 'front-noworld', depthDeg: 130, reps: 4 }, 0],
  ['head-on, image only, deep needs below parallel', { level: 'deep', view: 'front-noworld', depthDeg: 100, reps: 3 }, 0],
  ['head-on, image only, deep squats count', { level: 'deep', view: 'front-noworld', depthDeg: 75, reps: 3 }, 3],
];

let failed = 0;
for (const [name, opts, want] of cases) {
  const got = run(opts);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: counted ${got}, expected ${want}`);
}

// Missing-body messages.
assert.equal(legMetrics(undefined).missing, 'body');
const { image } = pose(175, 'side');
image[27].visibility = image[28].visibility = 0.1;
assert.equal(legMetrics(image, null).missing, 'feet');
console.log('PASS  missing-landmark reasons');

process.exit(failed ? 1 : 0);
