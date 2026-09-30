/**
 * Rogue Protocol's sound, synthesised live with Web Audio like the rest of
 * Spatial Desktop: no audio files. Positioned sounds (explosions, enemy fire)
 * go through panners, so the app's listener (kept on your head by
 * SfxListenerSystem) tells you where a threat is.
 *
 * The soundtrack is a small sequencer in D minor (the ambient score's key) at
 * 128 BPM over i–VI–III–VII, with layers that come in by intensity: 0 for the
 * menus, 1 in combat, 2 against the Overseer.
 */

type Vec = { x: number; y: number; z: number };

const BPM = 128;
const STEP = 60 / BPM / 4;
// Dm, Bb, F, C: root MIDI notes and chord tones, two bars each.
const CHORDS = [
  { root: 38, tones: [62, 65, 69, 74] },
  { root: 34, tones: [58, 62, 65, 70] },
  { root: 41, tones: [60, 65, 69, 72] },
  { root: 36, tones: [60, 64, 67, 72] },
];
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

export class GameAudio {
  enabled = true;
  musicEnabled = true;
  private readonly sfxBus: GainNode;
  private readonly musicBus: GainNode;
  private readonly duck: GainNode;
  private readonly delay: DelayNode;
  private readonly noiseBuffer: AudioBuffer;
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextStep = 0;
  private step = 0;
  private intensity = 0;
  private last = new Map<string, number>();

  constructor(private readonly c: AudioContext) {
    const out = new GainNode(c, { gain: 0.9 });
    const limiter = new DynamicsCompressorNode(c, { threshold: -10, knee: 6, ratio: 8, attack: 0.003, release: 0.15 });
    out.connect(limiter).connect(c.destination);
    this.sfxBus = new GainNode(c, { gain: 0.55 });
    this.sfxBus.connect(out);
    this.duck = new GainNode(c, { gain: 1 });
    this.musicBus = new GainNode(c, { gain: 0 });
    this.musicBus.connect(this.duck).connect(out);
    // Ping-pong-ish feedback delay for the arpeggio.
    this.delay = new DelayNode(c, { delayTime: STEP * 3 });
    const feedback = new GainNode(c, { gain: 0.38 });
    const tone = new BiquadFilterNode(c, { type: 'lowpass', frequency: 2400 });
    this.delay.connect(tone).connect(feedback).connect(this.delay);
    tone.connect(new GainNode(c, { gain: 0.5 })).connect(this.musicBus);

    this.noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  private get ready(): boolean {
    return this.enabled && this.c.state === 'running';
  }

  /** Rate-limit a sound so dozens of simultaneous events don't clip. */
  private gate(name: string, gap: number): boolean {
    const t = this.c.currentTime;
    if (t - (this.last.get(name) ?? -1) < gap) return false;
    this.last.set(name, t);
    return true;
  }

  private dest(at?: Vec, rolloff = 0.35): AudioNode {
    if (!at) return this.sfxBus;
    const panner = new PannerNode(this.c, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 3,
      rolloffFactor: rolloff,
      positionX: at.x,
      positionY: at.y,
      positionZ: at.z,
    });
    panner.connect(this.sfxBus);
    setTimeout(() => panner.disconnect(), 3000);
    return panner;
  }

  private env(start: number, length: number, peak: number, attack = 0.003): GainNode {
    const g = new GainNode(this.c, { gain: 0 });
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(length, attack + 0.01));
    return g;
  }

  private osc(dest: AudioNode, type: OscillatorType, freq: number, start: number, length: number, peak: number, to?: number, attack?: number): void {
    const o = new OscillatorNode(this.c, { type, frequency: freq });
    if (to) o.frequency.exponentialRampToValueAtTime(to, start + length);
    o.connect(this.env(start, length, peak, attack)).connect(dest);
    o.start(start);
    o.stop(start + length + 0.05);
  }

  private hiss(dest: AudioNode, start: number, length: number, peak: number, type: BiquadFilterType, freq: number, to?: number, q = 0.8, attack?: number): void {
    const s = new AudioBufferSourceNode(this.c, { buffer: this.noiseBuffer, loop: true });
    const f = new BiquadFilterNode(this.c, { type, frequency: freq, Q: q });
    if (to) f.frequency.exponentialRampToValueAtTime(to, start + length);
    s.connect(f).connect(this.env(start, length, peak, attack)).connect(dest);
    s.start(start, Math.random() * 0.8);
    s.stop(start + length + 0.05);
  }

  // ---- effects ------------------------------------------------------------------

  /** Your blaster: a bright zap that falls in pitch. */
  laser(): void {
    if (!this.ready || !this.gate('laser', 0.045)) return;
    const t = this.c.currentTime;
    const d = this.sfxBus;
    this.osc(d, 'square', 1800 + Math.random() * 200, t, 0.09, 0.05, 260);
    this.osc(d, 'sine', 900, t, 0.06, 0.07, 180);
    this.hiss(d, t, 0.04, 0.04, 'highpass', 5000);
  }

  enemyShot(at: Vec): void {
    if (!this.ready || !this.gate('enemyShot', 0.06)) return;
    const t = this.c.currentTime;
    const d = this.dest(at);
    this.osc(d, 'sawtooth', 520, t, 0.22, 0.09, 110);
    this.osc(d, 'square', 260, t, 0.16, 0.05, 90);
  }

  hit(at: Vec): void {
    if (!this.ready || !this.gate('hit', 0.03)) return;
    const t = this.c.currentTime;
    const d = this.dest(at, 0.2);
    this.osc(d, 'triangle', 2400, t, 0.05, 0.08, 1400);
    this.hiss(d, t, 0.05, 0.05, 'bandpass', 3000);
  }

  /** Size 1 is a drone, ~3 a gunner, 6+ the Overseer. */
  explosion(at: Vec, size = 1): void {
    if (!this.ready || !this.gate('explosion', 0.04)) return;
    const t = this.c.currentTime;
    const d = this.dest(at, 0.25);
    const length = 0.5 + size * 0.25;
    this.hiss(d, t, length, 0.22 + size * 0.03, 'lowpass', 3500 + size * 400, 120, 0.7);
    this.osc(d, 'sine', 140 + 40 / size, t, 0.35 + size * 0.1, 0.35, 32);
    this.hiss(d, t, 0.08, 0.12, 'highpass', 2500);
    if (size >= 3) this.osc(d, 'sawtooth', 70, t + 0.02, length, 0.08, 25);
  }

  hurt(): void {
    if (!this.ready || !this.gate('hurt', 0.1)) return;
    const t = this.c.currentTime;
    this.osc(this.sfxBus, 'sawtooth', 160, t, 0.35, 0.18, 50);
    this.hiss(this.sfxBus, t, 0.3, 0.2, 'lowpass', 1800, 200);
  }

  shieldBlock(at: Vec): void {
    if (!this.ready || !this.gate('block', 0.04)) return;
    const t = this.c.currentTime;
    const d = this.dest(at, 0.1);
    [1320, 1980, 2970].forEach((f, i) => this.osc(d, 'sine', f, t, 0.45 - i * 0.1, 0.07 / (i + 1)));
    this.hiss(d, t, 0.12, 0.06, 'bandpass', 6000);
  }

  shieldHum(on: boolean): void {
    if (!this.ready || !on || !this.gate('hum', 0.12)) return;
    const t = this.c.currentTime;
    this.osc(this.sfxBus, 'sine', 110, t, 0.16, 0.025, 112, 0.05);
    this.osc(this.sfxBus, 'triangle', 220, t, 0.16, 0.012, 224, 0.05);
  }

  nova(): void {
    if (!this.ready) return;
    const t = this.c.currentTime;
    this.hiss(this.sfxBus, t, 0.35, 0.18, 'bandpass', 300, 6000, 1.2, 0.3);
    this.osc(this.sfxBus, 'sine', 90, t + 0.3, 1.4, 0.5, 28);
    this.hiss(this.sfxBus, t + 0.3, 1.6, 0.3, 'lowpass', 5000, 90, 0.6);
    [74, 81, 86].forEach((n) => this.osc(this.sfxBus, 'sawtooth', midi(n), t + 0.3, 1.2, 0.03, midi(n - 12)));
  }

  pickup(): void {
    if (!this.ready) return;
    const t = this.c.currentTime;
    [74, 78, 81, 86].forEach((n, i) => this.osc(this.sfxBus, 'triangle', midi(n), t + i * 0.055, 0.35, 0.07));
  }

  charge(at: Vec, seconds: number): void {
    if (!this.ready) return;
    const t = this.c.currentTime;
    const d = this.dest(at, 0.15);
    this.osc(d, 'sine', 180, t, seconds, 0.09, 1400, seconds * 0.9);
    this.osc(d, 'sawtooth', 90, t, seconds, 0.03, 700, seconds * 0.9);
  }

  beam(at: Vec): void {
    if (!this.ready) return;
    const t = this.c.currentTime;
    const d = this.dest(at, 0.1);
    this.hiss(d, t, 0.5, 0.25, 'bandpass', 1500, 300, 0.6);
    this.osc(d, 'sawtooth', 220, t, 0.45, 0.12, 55);
  }

  warpIn(at: Vec): void {
    if (!this.ready || !this.gate('warpIn', 0.08)) return;
    const t = this.c.currentTime;
    this.hiss(this.dest(at, 0.2), t, 0.35, 0.07, 'bandpass', 4000, 400, 2);
  }

  warp(): void {
    if (!this.ready) return;
    const t = this.c.currentTime;
    this.hiss(this.sfxBus, t, 2.2, 0.12, 'bandpass', 150, 3500, 1.5, 1.2);
    this.osc(this.sfxBus, 'sawtooth', 55, t, 2.2, 0.05, 220, 1.2);
    this.hiss(this.sfxBus, t + 1.9, 0.8, 0.14, 'lowpass', 6000, 200);
  }

  waveStart(): void {
    if (!this.ready) return;
    const t = this.c.currentTime;
    [62, 69, 74, 77].forEach((n, i) => this.osc(this.sfxBus, 'square', midi(n), t + i * 0.09, 0.3, 0.035));
    this.osc(this.sfxBus, 'sawtooth', midi(50), t, 0.8, 0.05);
  }

  lowHull(): void {
    if (!this.ready || !this.gate('alarm', 1.2)) return;
    const t = this.c.currentTime;
    this.osc(this.sfxBus, 'square', 880, t, 0.12, 0.03);
    this.osc(this.sfxBus, 'square', 660, t + 0.15, 0.12, 0.03);
  }

  gameOver(): void {
    if (!this.ready) return;
    const t = this.c.currentTime;
    [74, 70, 65, 62, 50].forEach((n, i) => this.osc(this.sfxBus, 'sawtooth', midi(n), t + i * 0.22, 0.6, 0.05, midi(n) * 0.97));
    this.hiss(this.sfxBus, t, 2.5, 0.12, 'lowpass', 3000, 60);
  }

  // ---- music ----------------------------------------------------------------------

  startMusic(intensity: number): void {
    this.intensity = intensity;
    const target = this.musicEnabled ? 0.34 : 0;
    this.musicBus.gain.setTargetAtTime(target, this.c.currentTime, 0.4);
    if (this.timer) return;
    this.step = 0;
    this.nextStep = this.c.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  setIntensity(intensity: number): void {
    this.intensity = intensity;
  }

  stopMusic(fade = 0.6): void {
    this.musicBus.gain.setTargetAtTime(0, this.c.currentTime, fade / 3);
    const timer = this.timer;
    this.timer = undefined;
    setTimeout(() => clearInterval(timer), fade * 1000 + 200);
  }

  private schedule(): void {
    if (this.c.state !== 'running') {
      this.nextStep = this.c.currentTime + 0.1;
      return;
    }
    while (this.nextStep < this.c.currentTime + 0.12) {
      this.playStep(this.step, this.nextStep);
      this.step++;
      this.nextStep += STEP;
    }
  }

  private playStep(step: number, t: number): void {
    const level = this.intensity;
    const s = step % 16;
    const chord = CHORDS[Math.floor(step / 32) % CHORDS.length];
    const m = this.musicBus;

    // Pad at the top of each chord.
    if (step % 32 === 0) {
      for (const n of chord.tones.slice(0, 3)) {
        for (const detune of [-7, 7]) {
          const o = new OscillatorNode(this.c, { type: 'sawtooth', frequency: midi(n - 12), detune });
          const f = new BiquadFilterNode(this.c, { type: 'lowpass', frequency: level >= 2 ? 1600 : 900, Q: 0.5 });
          const g = new GainNode(this.c, { gain: 0 });
          const length = STEP * 32;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.022, t + 0.6);
          g.gain.setValueAtTime(0.022, t + length - 0.5);
          g.gain.linearRampToValueAtTime(0, t + length + 0.2);
          o.connect(f).connect(g).connect(m);
          o.start(t);
          o.stop(t + length + 0.3);
        }
      }
    }

    if (level >= 1) {
      // Kick on the beat, with the rest of the mix ducking under it.
      if (s % 4 === 0) {
        this.osc(m, 'sine', 150, t, 0.28, 0.9, 42, 0.002);
        this.duck.gain.setValueAtTime(0.55, t);
        this.duck.gain.linearRampToValueAtTime(1, t + STEP * 3);
      }
      // Rolling bass: off-16ths of the root.
      if (s % 4 !== 0) {
        const note = midi(chord.root + (s % 8 === 6 ? 12 : 0));
        const o = new OscillatorNode(this.c, { type: 'sawtooth', frequency: note });
        const f = new BiquadFilterNode(this.c, { type: 'lowpass', frequency: 300, Q: 4 });
        f.frequency.setValueAtTime(level >= 2 ? 1400 : 900, t);
        f.frequency.exponentialRampToValueAtTime(180, t + STEP * 0.9);
        o.connect(f).connect(this.env(t, STEP * 0.95, 0.16)).connect(m);
        o.start(t);
        o.stop(t + STEP + 0.05);
      }
      // Hats.
      this.hiss(m, t, s % 2 ? 0.03 : 0.05, s % 4 === 2 ? 0.05 : 0.025, 'highpass', 8000);
      if (level >= 2 && (s === 4 || s === 12)) this.hiss(m, t, 0.18, 0.14, 'bandpass', 1800, 900, 0.8);
    }

    // Arpeggio through the delay.
    if (level >= 1 || s % 2 === 0) {
      const tones = chord.tones;
      const n = tones[(step * (level >= 2 ? 3 : 1)) % tones.length] + (s >= 8 && level >= 2 ? 12 : 0);
      const o = new OscillatorNode(this.c, { type: 'square', frequency: midi(n) });
      const f = new BiquadFilterNode(this.c, { type: 'lowpass', frequency: level ? 3200 : 1500 });
      const g = this.env(t, STEP * 0.8, level ? 0.03 : 0.02);
      o.connect(f).connect(g);
      g.connect(m);
      g.connect(this.delay);
      o.start(t);
      o.stop(t + STEP);
    }
  }
}
