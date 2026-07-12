/**
 * WebAudio scan feedback — synthesized beeps, no audio files (CSP-safe, no
 * external URLs). A short high beep on success, a low buzz on failure. The
 * AudioContext is created lazily on first user gesture (browser autoplay rule)
 * and reused.
 */
let ctx = null;

function context() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Call once from a user gesture to unlock audio on iOS/Safari. */
export function primeAudio() {
  const c = context();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

function tone(freq, durationMs, type = 'sine', gain = 0.08) {
  const c = context();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g);
  g.connect(c.destination);
  const now = c.currentTime;
  g.gain.setValueAtTime(gain, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
  osc.start(now);
  osc.stop(now + durationMs / 1000);
}

export function beepOk() {
  tone(880, 90, 'sine', 0.09);
  setTimeout(() => tone(1180, 70, 'sine', 0.07), 60);
}

export function buzzError() {
  tone(200, 240, 'square', 0.09);
}
