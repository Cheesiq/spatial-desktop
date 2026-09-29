/**
 * UI sound effects, synthesised live with Web Audio like the music: no audio
 * files. Pitches come from the music's D major pentatonic so the sounds sit
 * inside whatever the ambient score is playing.
 *
 * Sounds given a position (panels, the launcher) are spatialised, so in VR a
 * panel closing to your left is heard on your left; the rest are head-locked.
 */
import { createSystem, Quaternion, Vector3 } from '@iwsdk/core';

export type Sound =
  | 'hover'
  | 'press'
  | 'on'
  | 'off'
  | 'open'
  | 'close'
  | 'grab'
  | 'drop'
  | 'focus'
  | 'unfocus'
  | 'keyboard'
  | 'release'
  | 'layout'
  | 'tick'
  | 'error'
  | 'enter'
  | 'exit';

export interface PlayOptions {
  /** World position to play from; omitted means head-locked. */
  at?: { x: number; y: number; z: number };
  /** 0..1, for sounds that follow a value (the slider tick). */
  value?: number;
}

// D major pentatonic from D5 up.
const D5 = 587.33;
const E5 = 659.26;
const FS5 = 739.99;
const A5 = 880;
const B5 = 987.77;
const D6 = 1174.66;
const E6 = 1318.51;
const A6 = 1760;
const SCALE = [D5, E5, FS5, A5, B5, D6, E6, 1479.98, A6];

/** Minimum seconds between repeats, so sweeping a ray over tiles doesn't buzz. */
const MIN_GAP: Partial<Record<Sound, number>> = { hover: 0.05, tick: 0.03, press: 0.03 };

interface ToneOptions {
  gain?: number;
  type?: OscillatorType;
  /** Glide to this frequency over the tone. */
  to?: number;
  attack?: number;
}

interface NoiseOptions {
  gain?: number;
  type?: BiquadFilterType;
  freq: number;
  /** Sweep the filter to this frequency over the burst. */
  to?: number;
  q?: number;
}

class Sfx {
  enabled = true;
  private context: AudioContext | null = null;
  private bus!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private lowEnd = false;
  private readonly last = new Map<Sound, number>();

  attach(context: AudioContext, options: { lowEnd?: boolean } = {}): void {
    this.context = context;
    this.lowEnd = options.lowEnd ?? false;

    // bus -> (dry + short room) -> out -> destination
    const out = context.createGain();
    out.gain.value = 0.6;
    out.connect(context.destination);
    this.bus = context.createGain();
    this.bus.connect(out);
    const room = context.createConvolver();
    room.buffer = impulse(context, this.lowEnd ? 0.4 : 0.9);
    const send = context.createGain();
    send.gain.value = 0.22;
    this.bus.connect(send).connect(room).connect(out);

    this.noiseBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  /** Where the listener is and which way it faces, in world space. */
  setListener(position: Vector3, forward: Vector3, up: Vector3): void {
    const listener = this.context?.listener;
    if (!listener?.positionX) return;
    listener.positionX.value = position.x;
    listener.positionY.value = position.y;
    listener.positionZ.value = position.z;
    listener.forwardX.value = forward.x;
    listener.forwardY.value = forward.y;
    listener.forwardZ.value = forward.z;
    listener.upX.value = up.x;
    listener.upY.value = up.y;
    listener.upZ.value = up.z;
  }

  play(sound: Sound, options: PlayOptions = {}): void {
    const c = this.context;
    // A suspended context would queue sounds and fire them all at once later.
    if (!this.enabled || !c || c.state !== 'running') return;
    const t = c.currentTime;
    const gap = MIN_GAP[sound];
    if (gap && t - (this.last.get(sound) ?? -1) < gap) return;
    this.last.set(sound, t);

    let dest: AudioNode = this.bus;
    let panner: PannerNode | null = null;
    if (options.at) {
      panner = new PannerNode(c, {
        panningModel: this.lowEnd ? 'equalpower' : 'HRTF',
        distanceModel: 'inverse',
        refDistance: 1,
        rolloffFactor: 0.6,
        positionX: options.at.x,
        positionY: options.at.y,
        positionZ: options.at.z,
      });
      panner.connect(this.bus);
      dest = panner;
    }

    const length = this.voice(sound, dest, t, options.value ?? 0);
    if (panner) setTimeout(() => panner.disconnect(), (length + 0.5) * 1000);
  }

  /** Schedule one sound into `dest`; returns its length in seconds. */
  private voice(sound: Sound, dest: AudioNode, t: number, value: number): number {
    switch (sound) {
      case 'hover':
        this.tone(dest, A6, t, 0.035, { gain: 0.02 });
        return 0.05;
      case 'press':
        this.tone(dest, D6, t, 0.05, { gain: 0.05, type: 'triangle', to: A5 });
        this.noise(dest, t, 0.012, { gain: 0.03, type: 'highpass', freq: 4000 });
        return 0.06;
      case 'on':
        this.tone(dest, D5, t, 0.09, { gain: 0.06, type: 'triangle' });
        this.bell(dest, A5, t + 0.06, 0.25, 0.05);
        return 0.35;
      case 'off':
        this.tone(dest, A5, t, 0.09, { gain: 0.05, type: 'triangle' });
        this.bell(dest, D5, t + 0.06, 0.2, 0.045);
        return 0.3;
      case 'open':
        this.noise(dest, t, 0.3, { gain: 0.04, freq: 300, to: 2500, q: 1.2 });
        [D5, FS5, A5, D6].forEach((f, i) => this.bell(dest, f, t + i * 0.05, 0.5, 0.04));
        return 0.7;
      case 'close':
        this.noise(dest, t, 0.28, { gain: 0.035, freq: 2500, to: 300, q: 1.2 });
        [A5, E5, D5].forEach((f, i) => this.tone(dest, f, t + i * 0.05, 0.3, { gain: 0.04, type: 'triangle' }));
        return 0.45;
      case 'grab':
        this.tone(dest, 196, t, 0.08, { gain: 0.1, to: 150 });
        this.noise(dest, t, 0.03, { gain: 0.025, type: 'lowpass', freq: 1200 });
        return 0.1;
      case 'drop':
        this.tone(dest, 150, t, 0.12, { gain: 0.1, to: 110 });
        this.noise(dest, t, 0.02, { gain: 0.03, type: 'bandpass', freq: 2000, q: 2 });
        return 0.14;
      case 'focus':
        this.bell(dest, B5, t, 0.5, 0.04);
        this.bell(dest, E6, t + 0.04, 0.6, 0.035);
        return 0.7;
      case 'unfocus':
        this.bell(dest, E6, t, 0.35, 0.03);
        this.bell(dest, B5, t + 0.04, 0.45, 0.035);
        return 0.55;
      case 'keyboard':
        this.tone(dest, B5, t, 0.05, { gain: 0.045, type: 'triangle' });
        this.tone(dest, E6, t + 0.05, 0.1, { gain: 0.045, type: 'triangle' });
        return 0.16;
      case 'release':
        this.tone(dest, E6, t, 0.05, { gain: 0.035, type: 'triangle' });
        this.tone(dest, B5, t + 0.05, 0.08, { gain: 0.035, type: 'triangle' });
        return 0.14;
      case 'layout':
        this.noise(dest, t, 0.35, { gain: 0.04, freq: 500, to: 3000, q: 0.8 });
        [FS5, A5, D6].forEach((f, i) => this.bell(dest, f, t + i * 0.07, 0.4, 0.03));
        return 0.6;
      case 'tick': {
        const f = SCALE[Math.round(Math.min(1, Math.max(0, value)) * (SCALE.length - 1))];
        this.tone(dest, f * 2, t, 0.025, { gain: 0.03 });
        return 0.03;
      }
      case 'error':
        // Deliberately outside the key.
        this.tone(dest, 329.63, t, 0.12, { gain: 0.06, type: 'triangle' });
        this.tone(dest, 277.18, t + 0.12, 0.22, { gain: 0.06, type: 'triangle' });
        return 0.36;
      case 'enter':
        this.noise(dest, t, 0.6, { gain: 0.035, freq: 200, to: 4000, q: 0.7 });
        [D5, A5, D6, E6].forEach((f) => this.bell(dest, f, t + 0.3, 1.2, 0.025));
        return 1.5;
      case 'exit':
        this.noise(dest, t, 0.5, { gain: 0.035, freq: 4000, to: 200, q: 0.7 });
        [A5, D5].forEach((f, i) => this.bell(dest, f, t + 0.1 + i * 0.1, 0.8, 0.03));
        return 1;
    }
  }

  private tone(dest: AudioNode, freq: number, start: number, length: number, options: ToneOptions = {}): void {
    const c = this.context!;
    const { gain = 0.05, type = 'sine', to, attack = 0.004 } = options;
    const oscillator = new OscillatorNode(c, { type, frequency: freq });
    if (to) oscillator.frequency.exponentialRampToValueAtTime(to, start + length);
    const envelope = envelopeGain(c, start, length, gain, attack);
    oscillator.connect(envelope).connect(dest);
    oscillator.start(start);
    oscillator.stop(start + length + 0.02);
  }

  /** A struck bell: the fundamental plus two quickly fading inharmonic partials. */
  private bell(dest: AudioNode, freq: number, start: number, length: number, gain: number): void {
    this.tone(dest, freq, start, length, { gain, attack: 0.002 });
    this.tone(dest, freq * 2.76, start, length * 0.4, { gain: gain * 0.25, attack: 0.002 });
    this.tone(dest, freq * 5.4, start, length * 0.2, { gain: gain * 0.08, attack: 0.002 });
  }

  private noise(dest: AudioNode, start: number, length: number, options: NoiseOptions): void {
    const c = this.context!;
    const { gain = 0.03, type = 'bandpass', freq, to, q = 1 } = options;
    const source = new AudioBufferSourceNode(c, { buffer: this.noiseBuffer });
    const filter = new BiquadFilterNode(c, { type, frequency: freq, Q: q });
    if (to) filter.frequency.exponentialRampToValueAtTime(to, start + length);
    // Swells rather than clicks for the longer sweeps.
    const envelope = envelopeGain(c, start, length, gain, Math.min(0.4 * length, 0.15));
    source.connect(filter).connect(envelope).connect(dest);
    // Random offset so repeated bursts don't sound identical.
    source.start(start, Math.random() * 0.5);
    source.stop(start + length + 0.02);
  }
}

function envelopeGain(c: BaseAudioContext, start: number, length: number, peak: number, attack: number): GainNode {
  const gain = new GainNode(c, { gain: 0 });
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(length, attack + 0.005));
  return gain;
}

function impulse(context: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 4;
  }
  return buffer;
}

export const sfx = new Sfx();

/** Keeps the audio listener on the viewer's head so positioned sounds pan correctly. */
export class SfxListenerSystem extends createSystem({}) {
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly forward = new Vector3();
  private readonly up = new Vector3();

  update(): void {
    // Same rule as the launcher: in 2D the head node isn't where the camera is.
    const node = this.renderer.xr.isPresenting ? this.player.head : this.camera;
    node.getWorldPosition(this.position);
    node.getWorldQuaternion(this.rotation);
    this.forward.set(0, 0, -1).applyQuaternion(this.rotation);
    this.up.set(0, 1, 0).applyQuaternion(this.rotation);
    sfx.setListener(this.position, this.forward, this.up);
  }
}
