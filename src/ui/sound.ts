// Tiny WebAudio synth: no asset files. Silent until the first user gesture (autoplay policy),
// while muted, and in test builds. The mute flag lives in localStorage["srp:muted"].

type SoundEvent = "move" | "lap" | "finish" | "low" | "turn";

/** [frequency Hz, start s, length s] per note. */
const TONES: Record<SoundEvent, { wave: "sine" | "square" | "triangle"; gain: number; notes: Array<[number, number, number]> }> = {
  move: { wave: "triangle", gain: 0.05, notes: [[330, 0, 0.06]] },
  turn: { wave: "sine", gain: 0.09, notes: [[880, 0, 0.1]] },
  lap: { wave: "sine", gain: 0.12, notes: [[660, 0, 0.12], [880, 0.12, 0.2]] },
  low: { wave: "square", gain: 0.05, notes: [[440, 0, 0.1], [440, 0.18, 0.1]] },
  finish: {
    wave: "triangle",
    gain: 0.14,
    notes: [[523, 0, 0.15], [659, 0.15, 0.15], [784, 0.3, 0.15], [1047, 0.45, 0.5]]
  }
};

export const SOUND_EVENTS = Object.keys(TONES) as SoundEvent[];

export function shouldPlay(event: SoundEvent, muted: boolean): boolean {
  return !muted && event in TONES;
}

const MUTE_KEY = "srp:muted";

export function isMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean) {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // ignore: the flag then only lasts for this page
  }
  memoryMuted = muted;
}

// Fallback when storage is blocked: still honour the toggle for this page.
let memoryMuted: boolean | null = null;
export const currentlyMuted = () => memoryMuted ?? isMuted();

type Ctx = Pick<AudioContext, "currentTime" | "destination" | "state" | "resume" | "createOscillator" | "createGain">;

/** `makeContext` is injectable so the scheduling can be tested without a browser. */
export function createSynth(makeContext: () => Ctx | null, muted: () => boolean = currentlyMuted) {
  let ctx: Ctx | null = null;
  return {
    /** Call from a user gesture: browsers only let audio start from one. */
    unlock() {
      try {
        ctx ??= makeContext();
        if (ctx?.state === "suspended") void ctx.resume();
      } catch {
        ctx = null;
      }
    },
    play(event: SoundEvent) {
      if (!ctx || !shouldPlay(event, muted())) return;
      try {
        const { wave, gain, notes } = TONES[event];
        const t0 = ctx.currentTime;
        for (const [freq, start, length] of notes) {
          const osc = ctx.createOscillator();
          const amp = ctx.createGain();
          osc.type = wave;
          osc.frequency.value = freq;
          amp.gain.setValueAtTime(gain, t0 + start);
          amp.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length);
          osc.connect(amp).connect(ctx.destination);
          osc.start(t0 + start);
          osc.stop(t0 + start + length + 0.02);
        }
      } catch {
        // audio is a nicety, never a failure
      }
    }
  };
}

const synth = createSynth(() =>
  import.meta.env.MODE === "test" || typeof AudioContext === "undefined" ? null : new AudioContext()
);

export const play = synth.play;

/** Arms the first-gesture unlock; main.ts calls it once. */
export function initSound() {
  const unlock = () => {
    synth.unlock();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}
