# SquatClock

A PWA alarm clock that only turns off once you've done squats in front of the camera
(inspired by PushClock). Body tracking uses MediaPipe Pose and runs entirely on the
device. No video leaves the phone.

## Run locally

```bash
python -m http.server 5173
```

Open http://localhost:5173. Camera access needs a secure context: `localhost` works,
but on a phone you need HTTPS. The quickest options are GitHub Pages, Netlify or
Cloudflare Pages (it's all static files, so there's no build step), or
`npx localtunnel --port 5173` for a quick test.

## How it works

| File | What it does |
| --- | --- |
| `app.js` | UI, the scheduler (checks every second), ringing flow, wake lock |
| `squat.js` | Camera + MediaPipe Pose Landmarker, and the `RepCounter` state machine |
| `audio.js` | Alarm sounds generated with Web Audio (no audio files) |
| `store.js` | Alarms and stats in `localStorage`, next-fire-time calculation |
| `sw.js` | Offline cache for the app **and** the MediaPipe runtime + model (~15 MB) |

**Squat detection:** each frame gives a knee angle (hip–knee–ankle, from 3D world
landmarks) and a hip-drop ratio (hip-to-knee height vs. shin length, compared with your
standing baseline). A rep counts when you pass the depth threshold for the chosen
difficulty and then stand back up. The two signals together handle both side-on and
head-on camera angles. Your whole body, feet included, has to be in frame.

Anti-cheat details: the alarm keeps ringing while you squat. Each rep lowers the volume,
and if you stop for 15 s it goes back to full. The only other way out is holding the
emergency button for 10 s.

## Tests

```bash
node tools/test-reps.mjs
```

This simulates squats at different depths and camera angles and checks the rep count.
`node tools/make-icons.mjs` regenerates the icons.

## Platform limits (important)

A web app can't wake a sleeping phone the way a native alarm can. What this means in practice:

- **Keep SquatClock open in Bedside mode** overnight, with the phone plugged in. Bedside
  mode holds a screen wake lock and shows a dim clock.
- Tap once after opening the app to "arm" it, because browsers block sound until the
  user interacts.
- If the app is in the background when the alarm is due, it tries to show a notification
  (Android/desktop Chrome). Browsers throttle background timers, though, so this is a
  best-effort fallback. It is not a reliable alarm.
- iOS: install it with Share → Add to Home Screen. iOS suspends web apps when the screen
  locks, so Bedside mode (screen on) is required there.
- The first alarm needs the body-tracker download (the "Download" step on the home
  screen). After that it works offline.
