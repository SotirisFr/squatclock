// Squat detection: MediaPipe Pose Landmarker (runs fully on-device) + a small
// state machine that turns joint angles into rep counts.

export const MP_VERSION = '0.10.14';
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
export const MP_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// BlazePose landmark indices.
const L = { shoulder: 11, hip: 23, knee: 25, ankle: 27 };
const R = { shoulder: 12, hip: 24, knee: 26, ankle: 28 };
const LEG_BONES = [[23, 25], [25, 27], [24, 26], [26, 28]];

// How low you need to go, per difficulty.
//   angle: knee angle (degrees) that counts as "down"
//   drop:  hip-to-knee height, as a fraction of its standing value, that counts
//          as "down" — this catches squats filmed head-on where the knee angle
//          is foreshortened.
// The drop values are what an average thigh/shin geometry gives at the
// matching knee angle, so both signals agree on "deep enough".
export const LEVELS = {
  easy:   { angle: 125, drop: 0.85 },
  normal: { angle: 105, drop: 0.72 },
  deep:   { angle: 88,  drop: 0.58 },
};
const STANDING_ANGLE = 160;

let landmarkerPromise = null;
// The landmarker is shared and MediaPipe rejects timestamps that go backwards.
let lastTimestamp = 0;

/** Lazily loads the pose model once; later calls share the same promise. */
export function loadLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = (delegate) =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MP_MODEL, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      try {
        return await make('GPU');
      } catch {
        return await make('CPU');
      }
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

function angleAt(a, b, c) {
  // Angle ABC in degrees; works for 2D or 3D points.
  const v1 = [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)];
  const v2 = [c.x - b.x, c.y - b.y, (c.z ?? 0) - (b.z ?? 0)];
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const n = Math.hypot(...v1) * Math.hypot(...v2);
  if (!n) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, dot / n))) * 180) / Math.PI;
}

const vis = (p) => (p ? p.visibility ?? 1 : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Pull leg metrics out of one pose. Returns { angle, hipKnee, shin } or a
 * { missing } reason so the UI can tell the user what to fix.
 */
export function legMetrics(image, world) {
  if (!image) return { missing: 'body' };
  const score = (s) => Math.min(vis(image[s.hip]), vis(image[s.knee]), vis(image[s.ankle]));
  const sides = [L, R].filter((s) => score(s) > 0.5);
  if (!sides.length) {
    const hipsSeen = vis(image[L.hip]) > 0.5 || vis(image[R.hip]) > 0.5;
    return { missing: hipsSeen ? 'feet' : 'legs' };
  }
  let angle = 0, hipKnee = 0, shin = 0;
  for (const s of sides) {
    const src = world || image;
    angle += angleAt(src[s.hip], src[s.knee], src[s.ankle]);
    // Vertical distances in image space (y grows downward).
    hipKnee += image[s.knee].y - image[s.hip].y;
    shin += image[s.ankle].y - image[s.knee].y;
  }
  const n = sides.length;
  return { angle: angle / n, hipKnee: hipKnee / n, shin: shin / n };
}

/** Pure rep-counting state machine; feed it metrics every frame. */
export class RepCounter {
  constructor(level = 'normal') {
    this.cfg = LEVELS[level] || LEVELS.normal;
    this.reps = 0;
    this.state = 'up';
    this.angle = null;
    this.ratio = null;
    this.baseline = null; // hip-knee / shin ratio while standing
    this.downAt = 0;
    this.lastRepAt = 0;
    this.depth = 0;
  }

  update(m, t) {
    const k = 0.45; // smoothing
    const ratio = m.shin > 0.01 ? m.hipKnee / m.shin : null;
    this.angle = this.angle == null ? m.angle : this.angle + k * (m.angle - this.angle);
    if (ratio != null) this.ratio = this.ratio == null ? ratio : this.ratio + k * (ratio - this.ratio);

    // Learn what "standing" looks like from this camera angle: standing is when
    // the hips are highest, so track the upper envelope and let it sag only
    // slowly (the user may step closer/further away).
    if (this.ratio != null) {
      if (this.baseline == null || this.ratio > this.baseline) {
        this.baseline = this.baseline == null ? this.ratio : this.baseline + 0.3 * (this.ratio - this.baseline);
      } else if (this.state === 'up' && this.angle > STANDING_ANGLE) {
        this.baseline += 0.01 * (this.ratio - this.baseline);
      }
    }

    const byAngle = clamp01((STANDING_ANGLE - this.angle) / (STANDING_ANGLE - this.cfg.angle));
    let byDrop = 0;
    if (this.baseline && this.ratio != null) {
      const target = this.baseline * this.cfg.drop;
      byDrop = clamp01((this.baseline - this.ratio) / (this.baseline - target));
    }
    this.depth = Math.max(byAngle, byDrop);

    let event = null;
    if (this.state === 'up' && this.depth >= 1) {
      this.state = 'down';
      this.downAt = t;
      event = 'down';
    } else if (this.state === 'down' && this.depth < 0.25 && t - this.downAt > 150 && t - this.lastRepAt > 450) {
      this.state = 'up';
      this.reps += 1;
      this.lastRepAt = t;
      event = 'rep';
    }
    return event;
  }
}

/**
 * Owns the camera + detection loop. Calls onFrame({ reps, depth, state,
 * missing, event }) for every processed frame.
 */
export class SquatTracker {
  constructor({ video, canvas, level, onFrame }) {
    this.video = video;
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.counter = new RepCounter(level);
    this.onFrame = onFrame;
    this.stream = null;
    this.running = false;
    this.lastVideoTime = -1;
  }

  async startCamera() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  async start() {
    const [landmarker] = await Promise.all([loadLandmarker(), this.stream ? null : this.startCamera()]);
    this.landmarker = landmarker;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.process();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  process() {
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    if (this.canvas.width !== v.videoWidth) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = v.videoHeight;
    }
    const now = performance.now();
    lastTimestamp = Math.max(now, lastTimestamp + 1);
    let result;
    try {
      result = this.landmarker.detectForVideo(v, lastTimestamp);
    } catch {
      return;
    }
    const image = result.landmarks?.[0];
    const world = result.worldLandmarks?.[0];
    const m = legMetrics(image, world);
    let event = null;
    if (!m.missing) event = this.counter.update(m, now);
    this.draw(image, !m.missing);
    this.onFrame({
      reps: this.counter.reps,
      depth: m.missing ? 0 : this.counter.depth,
      state: this.counter.state,
      missing: m.missing || null,
      event,
    });
  }

  draw(pts, tracking) {
    const { g, canvas } = this;
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!pts) return;
    const W = canvas.width, H = canvas.height;
    const line = (a, b, color, w) => {
      if (vis(pts[a]) < 0.5 || vis(pts[b]) < 0.5) return;
      g.strokeStyle = color;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(pts[a].x * W, pts[a].y * H);
      g.lineTo(pts[b].x * W, pts[b].y * H);
      g.stroke();
    };
    g.lineCap = 'round';
    const torso = [[11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16]];
    torso.forEach(([a, b]) => line(a, b, 'rgba(255,255,255,0.55)', 4));
    const legColor = !tracking ? 'rgba(255,255,255,0.55)' : this.counter.state === 'down' ? '#32d583' : '#ff6a3d';
    LEG_BONES.forEach(([a, b]) => line(a, b, legColor, 8));
    g.fillStyle = '#fff';
    for (const i of [11, 12, 23, 24, 25, 26, 27, 28]) {
      if (vis(pts[i]) < 0.5) continue;
      g.beginPath();
      g.arc(pts[i].x * W, pts[i].y * H, 6, 0, Math.PI * 2);
      g.fill();
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
