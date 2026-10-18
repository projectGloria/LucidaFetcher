// Optional notification sounds, off by default.
//
// Synthesised with the Web Audio API rather than shipped as files: three short
// cues do not justify binary assets in the repo, and this way they cannot be
// missing at runtime. Each cue is a short two-note motif - distinguishable
// without being looked at, which is the whole point of a sound in a job that
// runs for an hour in the background.

let ctx = null;
const settings = { enabled: false, volume: 0.35 };
const active = new Set();
const pending = new Map();
let resuming = null;
const MAX_NOTES = 12;

async function audio() {
  if (!ctx || ctx.state === 'closed') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  const current = ctx;
  if (current.state === 'suspended') {
    if (resuming?.context !== current) {
      resuming = { context: current, promise: Promise.resolve(current.resume()) };
    }
    const work = resuming;
    try { await work.promise; }
    finally { if (resuming === work) resuming = null; }
  }
  return settings.enabled && current === ctx && current.state === 'running' ? current : null;
}

export function configureSounds(next) {
  if ('enabled' in next) settings.enabled = !!next.enabled;
  if ('volume' in next) {
    const value = Number(next.volume);
    settings.volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.35;
  }
  if (!settings.enabled) {
    pending.clear();
    resuming = null;
    for (const stop of [...active]) stop();
    const previous = ctx;
    ctx = null;
    // Closing a suspended or unavailable device can reject too.
    try { Promise.resolve(previous?.close()).catch(() => {}); } catch { /* optional audio */ }
  }
}
export function soundsEnabled() { return settings.enabled; }

async function tone(freqs, { duration = 0.13, type = 'sine', gain = 1 } = {}) {
  // Reserve before waiting for the device: a suspended context can take an
  // arbitrary time to resume, and result bursts must not queue unbounded cues.
  const waiting = [...pending.values()].reduce((sum, notes) => sum + notes, 0);
  if (!settings.enabled || !settings.volume || active.size + waiting + freqs.length > MAX_NOTES) return;
  const ticket = {};
  pending.set(ticket, freqs.length);
  try {
    const ac = await audio();
    if (!ac || !settings.volume || !pending.has(ticket)) return;
    freqs.forEach((f, i) => {
      const osc = ac.createOscillator();
      let amp;
      const cleanup = () => {
        active.delete(stop);
        osc.onended = null;
        try { osc.disconnect(); } catch { /* disconnected already */ }
        try { amp?.disconnect(); } catch { /* disconnected already */ }
      };
      const stop = () => {
        try { osc.stop(); } catch { /* never started or ended */ }
        cleanup();
      };
      active.add(stop);
      osc.onended = cleanup;
      try {
        amp = ac.createGain();
        osc.type = type;
        osc.frequency.value = f;
        const start = ac.currentTime + i * duration * 0.85;
        const peak = settings.volume * gain;
        // A short ramp instead of an abrupt start/stop: a hard gate on a sine wave
        // clicks audibly.
        amp.gain.setValueAtTime(0.0001, start);
        amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + 0.012);
        amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        osc.connect(amp).connect(ac.destination);
        osc.start(start);
        osc.stop(start + duration + 0.02);
      } catch (error) { stop(); throw error; }
    });
  } finally { pending.delete(ticket); }
}

export const cues = {
  // Rising perfect fourth - resolved, done.
  complete: () => tone([660, 880], { duration: 0.11 }),
  // Falling minor third - unresolved, something needs attention.
  skipped:  () => tone([520, 415], { duration: 0.15, type: 'triangle', gain: 0.85 }),
  // Longer, lower, two-step: the whole run has finished.
  finished: () => tone([523, 659, 784], { duration: 0.16 }),
  error:    () => tone([300, 220], { duration: 0.2, type: 'sawtooth', gain: 0.5 }),
};

export function play(name) {
  if (!settings.enabled || !settings.volume) return;
  const cue = cues[name];
  if (typeof cue === 'function') {
    try { Promise.resolve(cue()).catch(() => {}); } catch { /* optional audio must never break the UI */ }
  }
}
