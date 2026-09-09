// Optional notification sounds, off by default.
//
// Synthesised with the Web Audio API rather than shipped as files: three short
// cues do not justify binary assets in the repo, and this way they cannot be
// missing at runtime. Each cue is a short two-note motif - distinguishable
// without being looked at, which is the whole point of a sound in a job that
// runs for an hour in the background.

let ctx = null;
const settings = { enabled: false, volume: 0.35 };

function audio() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  // Autoplay policy parks the context until a gesture; every cue follows one.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function configureSounds(next) { Object.assign(settings, next); }
export function soundsEnabled() { return settings.enabled; }

function tone(freqs, { duration = 0.13, type = 'sine', gain = 1 } = {}) {
  const ac = audio();
  if (!ac) return;
  freqs.forEach((f, i) => {
    const osc = ac.createOscillator();
    const amp = ac.createGain();
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
  });
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
  if (!settings.enabled) return;
  const cue = cues[name];
  if (cue) { try { cue(); } catch (e) { /* audio is never worth breaking the UI for */ } }
}
