/**
 * Generative ambient music, synthesised live with Web Audio: a slow chord pad,
 * pentatonic bells, a ping-pong delay and a reverb. Nothing loops and there are
 * no audio files.
 *
 * `abundance` is p(note): the chance that each step (an eighth note) plays a
 * bell. It also brightens the pad and, near the top, adds short arpeggios, so
 * 0 is a bare drone and 1 is lush.
 */

/** D major pentatonic, as semitones above D. */
const PENTATONIC = [0, 2, 4, 7, 9];
const ROOT_HZ = 146.83; // D3
/** Chords as semitones above D: Dmaj9, Bm11, Gmaj9(#11), Em9, A(add9)/C#. */
const CHORDS = [
  [0, 4, 7, 11, 14],
  [-3, 0, 4, 7, 10],
  [-7, -3, 0, 4, 11],
  [-10, -3, 0, 2, 5],
  [-13, -5, 2, 7, 11],
];
const STEP_SECONDS = 0.5; // eighth notes at 60 bpm
const CHORD_STEPS = 32; // a new chord every 16 seconds
const LOOKAHEAD_SECONDS = 1;

const hz = (semitones: number) => ROOT_HZ * 2 ** (semitones / 12);

export interface MusicOptions {
  /** Shorter reverb and fewer pad voices for weak machines. */
  lowEnd?: boolean;
  /** Deterministic output, for tests. */
  seed?: number;
}

export class AmbientMusic {
  private readonly master: GainNode;
  private readonly bus: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private padVoices: Array<{ oscillators: OscillatorNode[]; gain: GainNode }> = [];
  private nextStep = 0;
  private nextStepTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private random: () => number;
  private _abundance = 0.35;
  /** Notes scheduled so far, for diagnostics. */
  readonly stats = { bells: 0, arpeggios: 0, chords: 0 };

  constructor(
    readonly context: BaseAudioContext,
    private readonly options: MusicOptions = {},
  ) {
    this.random = options.seed == null ? Math.random : mulberry32(options.seed);

    // master <- compressor <- (dry bus + delay + reverb)
    this.master = context.createGain();
    this.master.gain.value = 0;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 8;
    limiter.connect(this.master).connect(context.destination);

    this.bus = context.createGain();
    this.bus.connect(limiter);

    const reverb = context.createConvolver();
    reverb.buffer = impulse(context, options.lowEnd ? 1.8 : 4, this.random);
    const reverbSend = context.createGain();
    reverbSend.gain.value = 0.55;
    this.bus.connect(reverbSend).connect(reverb).connect(limiter);

    const delaySend = context.createGain();
    delaySend.gain.value = 0.3;
    const left = context.createDelay(2);
    const right = context.createDelay(2);
    left.delayTime.value = STEP_SECONDS * 1.5;
    right.delayTime.value = STEP_SECONDS * 1.5;
    const feedback = context.createGain();
    feedback.gain.value = 0.38;
    const merger = context.createChannelMerger(2);
    this.bus.connect(delaySend).connect(left);
    left.connect(right).connect(feedback).connect(left);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(reverb);
    merger.connect(limiter);

    this.padFilter = context.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.Q.value = 0.7;
    this.padFilter.frequency.value = this.padCutoff();
    this.padFilter.connect(this.bus);
    // Very slow filter breathing.
    const lfo = context.createOscillator();
    const lfoDepth = context.createGain();
    lfo.frequency.value = 1 / 23;
    lfoDepth.gain.value = 220;
    lfo.connect(lfoDepth).connect(this.padFilter.frequency);
    lfo.start();
  }

  get abundance(): number {
    return this._abundance;
  }

  set abundance(p: number) {
    this._abundance = Math.min(1, Math.max(0, p));
    this.padFilter.frequency.setTargetAtTime(this.padCutoff(), this.context.currentTime, 2);
  }

  /** Fade in and start scheduling (realtime contexts). */
  start(volume = 1.4): void {
    const now = this.context.currentTime;
    if (this.timer == null) {
      this.nextStepTime = Math.max(this.nextStepTime, now + 0.1);
      this.timer = setInterval(() => this.scheduleUntil(this.context.currentTime + LOOKAHEAD_SECONDS), 200);
      this.scheduleUntil(now + LOOKAHEAD_SECONDS);
    }
    this.setVolume(volume);
  }

  /** Fade the master volume; `start` calls this, offline renders call it alone. */
  setVolume(volume: number): void {
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(volume, now, 1.5);
  }

  /** Fade out and stop scheduling; sound tails off naturally. */
  stop(): void {
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0, now, 0.8);
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Schedule every step that starts before `time` (context seconds). */
  scheduleUntil(time: number): void {
    // Skip steps that are already in the past instead of replaying them all at
    // once: the audio clock can be far ahead of us (a context that started
    // earlier, or timers throttled in a background tab), and catching up would
    // build thousands of nodes in one go and play them as a burst.
    const now = this.context.currentTime;
    if (this.nextStepTime < now) {
      const missed = Math.ceil((now - this.nextStepTime) / STEP_SECONDS);
      const chordBefore = Math.floor(this.nextStep / CHORD_STEPS);
      this.nextStep += missed;
      this.nextStepTime += missed * STEP_SECONDS;
      // Landed mid-chord: bring the pad back in now rather than at the next change.
      if (Math.floor(this.nextStep / CHORD_STEPS) !== chordBefore || this.padVoices.length === 0) {
        if (this.nextStep % CHORD_STEPS !== 0) {
          this.playChord(CHORDS[Math.floor(this.nextStep / CHORD_STEPS) % CHORDS.length], this.nextStepTime);
        }
      }
    }
    while (this.nextStepTime < time) {
      this.step(this.nextStep, this.nextStepTime);
      this.nextStep++;
      this.nextStepTime += STEP_SECONDS;
    }
  }

  private padCutoff(): number {
    return 380 + this._abundance * 1400;
  }

  private step(index: number, time: number): void {
    const chordIndex = Math.floor(index / CHORD_STEPS) % CHORDS.length;
    const chord = CHORDS[chordIndex];
    if (index % CHORD_STEPS === 0) this.playChord(chord, time);

    // p(abundance): chance of a bell on this step, favouring downbeats.
    const onBeat = index % 2 === 0;
    const p = this._abundance * (onBeat ? 1 : 0.55);
    if (this.random() < p) this.playBell(this.pickNote(chord), time + this.random() * 0.04, 0.35 + this.random() * 0.4);

    // Near full abundance, occasional rising arpeggios through the chord.
    if (onBeat && this.random() < Math.max(0, this._abundance - 0.6) * 0.12) {
      this.stats.arpeggios++;
      const base = 12 * (1 + Math.floor(this.random() * 2));
      chord.slice(1).forEach((note, i) => this.playBell(note + base, time + i * STEP_SECONDS * 0.5, 0.3));
    }
  }

  /** A pentatonic note, usually a chord tone, in a random octave. */
  private pickNote(chord: number[]): number {
    const octave = 12 * (1 + Math.floor(this.random() * 2));
    if (this.random() < 0.6) return chord[Math.floor(this.random() * chord.length)] + octave;
    return PENTATONIC[Math.floor(this.random() * PENTATONIC.length)] + octave;
  }

  /** Crossfade the pad to a new chord over several seconds. */
  private playChord(chord: number[], time: number): void {
    const { context } = this;
    this.stats.chords++;
    for (const voice of this.padVoices) {
      voice.gain.gain.setTargetAtTime(0, time, 2.5);
      for (const osc of voice.oscillators) osc.stop(time + 14);
    }
    const notes = this.options.lowEnd ? chord.slice(0, 3) : chord;
    this.padVoices = notes.map((note, i) => {
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(0.06 / Math.sqrt(notes.length), time, 3);
      const pan = context.createStereoPanner();
      pan.pan.value = notes.length > 1 ? -0.6 + (1.2 * i) / (notes.length - 1) : 0;
      gain.connect(pan).connect(this.padFilter);
      // Two slightly detuned oscillators per note for a slow chorus.
      const oscillators = [-6, 6].map((cents) => {
        const osc = context.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = hz(note - 12);
        osc.detune.value = cents + (this.random() - 0.5) * 4;
        osc.connect(gain);
        osc.start(time);
        return osc;
      });
      return { oscillators, gain };
    });
  }

  /** A soft two-operator bell: sine carrier with a decaying inharmonic partial. */
  private playBell(semitones: number, time: number, velocity: number): void {
    const { context } = this;
    this.stats.bells++;
    const frequency = hz(semitones);
    const decay = 2.5 + this.random() * 2;

    const out = context.createGain();
    out.gain.setValueAtTime(0, time);
    out.gain.linearRampToValueAtTime(0.12 * velocity, time + 0.01);
    out.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    const pan = context.createStereoPanner();
    pan.pan.value = (this.random() - 0.5) * 1.4;
    out.connect(pan).connect(this.bus);

    const carrier = context.createOscillator();
    carrier.frequency.value = frequency;
    const modulator = context.createOscillator();
    modulator.frequency.value = frequency * 3.5;
    const modDepth = context.createGain();
    modDepth.gain.setValueAtTime(frequency * 1.2, time);
    modDepth.gain.exponentialRampToValueAtTime(1, time + decay * 0.4);
    modulator.connect(modDepth).connect(carrier.frequency);
    carrier.connect(out);

    for (const osc of [carrier, modulator]) {
      osc.start(time);
      osc.stop(time + decay + 0.1);
    }
  }
}

/** Decaying stereo noise: a cheap, smooth hall reverb. */
function impulse(context: BaseAudioContext, seconds: number, random: () => number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (random() * 2 - 1) * (1 - i / length) ** 3;
  }
  return buffer;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
