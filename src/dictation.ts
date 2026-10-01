/**
 * Push-to-talk for Claude workers: records the microphone while held, then
 * posts 16 kHz mono WAV to the server, which transcribes it locally with
 * voxtype and types the text into the current worker (see server/claude.ts).
 */

const RATE = 16000;
/** The server refuses more than a minute; stop a little before that. */
const MAX_SECONDS = 58;

// Copies the microphone's samples out of the audio thread.
const WORKLET = `registerProcessor('dictation-tap', class extends AudioWorkletProcessor {
  process([input]) {
    if (input[0]) this.port.postMessage(input[0].slice());
    return true;
  }
});`;

export interface DictationResult {
  text: string;
  worker: number;
}

export class Dictation {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private chunks: Float32Array[] = [];
  private limit: ReturnType<typeof setTimeout> | undefined;
  /** Called when recording stops by itself at the length limit. */
  onLimit: () => void = () => {};

  get recording(): boolean {
    return this.stream != null;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    this.chunks = [];
    // Its own context: the music's may run at any rate and is sometimes suspended.
    const context = new AudioContext();
    this.context = context;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    // Stopped while the worklet was loading.
    if (this.stream !== stream) return;
    const tap = new AudioWorkletNode(context, 'dictation-tap');
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => this.chunks.push(event.data);
    context.createMediaStreamSource(stream).connect(tap);
    // Outputs silence; connected so the browser keeps pulling audio through it.
    tap.connect(context.destination);
    this.limit = setTimeout(() => this.onLimit(), MAX_SECONDS * 1000);
  }

  /** Stop recording; resolves with the WAV, or null if nothing was recorded. */
  async stop(): Promise<Blob | null> {
    clearTimeout(this.limit);
    const { stream, context, chunks } = this;
    this.stream = this.context = null;
    this.chunks = [];
    stream?.getTracks().forEach((track) => track.stop());
    if (!context) return null;
    const rate = context.sampleRate;
    await context.close();
    const samples = downsample(chunks, rate);
    // Under a quarter of a second is a tap, not speech.
    return samples.length < RATE / 4 ? null : wav(samples);
  }

  /** Send a recording to the current worker; `submit` also presses Enter. */
  static async send(audio: Blob, submit: boolean): Promise<DictationResult> {
    const response = await fetch(`/api/claude/dictate${submit ? '?submit=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: audio,
    });
    const result = (await response.json()) as Partial<DictationResult> & { error?: string };
    if (!response.ok) throw new Error(result.error ?? response.statusText);
    return { text: result.text ?? '', worker: result.worker ?? 0 };
  }
}

/** Join the chunks and resample to 16 kHz, averaging each output sample's span. */
function downsample(chunks: Float32Array[], rate: number): Float32Array {
  const input = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  const ratio = rate / RATE;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j];
    output[i] = sum / (to - from);
  }
  return output;
}

/** 16-bit PCM WAV. */
function wav(samples: Float32Array): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true));
  return new Blob([view.buffer], { type: 'audio/wav' });
}
