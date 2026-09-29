// Renders the ambient music offline at several abundance levels and checks the
// output numerically (it can't be listened to from a test):
//   CDP_PORT=9224 node scripts/music-test.mjs [out-dir]
// Also writes a WAV of p=0.5 so a human can listen to it.
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2];
const { js, reload, close } = await connect();
await reload();

const render = (p, lowEnd, wav) => `(async () => {
  const { AmbientMusic } = await import('/src/music.ts');
  const seconds = 40, rate = 44100;
  const ctx = new OfflineAudioContext(2, seconds * rate, rate);
  const music = new AmbientMusic(ctx, { seed: 7, lowEnd: ${lowEnd} });
  music.abundance = ${p};
  music.setVolume(1.4);
  music.scheduleUntil(seconds);
  const t0 = performance.now();
  const buffer = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  let peak = 0, sum = 0, bad = 0, n = 0;
  const windows = [];
  for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) { bad++; continue; }
      const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; n++;
    }
  }
  // Loudness per 5 s window (left channel), to see it never drops out.
  const left = buffer.getChannelData(0);
  for (let w = 0; w < seconds; w += 5) {
    let s = 0; const from = w * rate, to = (w + 5) * rate;
    for (let i = from; i < to; i++) s += left[i] * left[i];
    windows.push((20 * Math.log10(Math.sqrt(s / (to - from)) || 1e-9)).toFixed(0));
  }
  let wavB64 = null;
  if (${wav}) {
    const frames = buffer.length, bytes = new DataView(new ArrayBuffer(44 + frames * 4));
    const str = (o, s) => [...s].forEach((ch, i) => bytes.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF'); bytes.setUint32(4, 36 + frames * 4, true); str(8, 'WAVEfmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true);
    bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 4, true); bytes.setUint16(32, 4, true); bytes.setUint16(34, 16, true);
    str(36, 'data'); bytes.setUint32(40, frames * 4, true);
    const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      bytes.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      bytes.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    const u8 = new Uint8Array(bytes.buffer); let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    wavB64 = btoa(bin);
  }
  return { p: ${p}, lowEnd: ${lowEnd}, rmsDb: +(20 * Math.log10(Math.sqrt(sum / n))).toFixed(1), peak: +peak.toFixed(3),
    nonFinite: bad, notes: { ...music.stats }, per5sDb: windows.join(' '), realtimeX: +((seconds * 1000) / renderMs).toFixed(0), wavB64 };
})()`;

const rows = [];
for (const [p, lowEnd] of [[0, false], [0.35, false], [0.95, false], [0.35, true]]) {
  const r = await js(render(p, lowEnd, out && p === 0.35 && !lowEnd));
  if (r.wavB64) writeFileSync(`${out}/ambient-p035.wav`, Buffer.from(r.wavB64, 'base64'));
  delete r.wavB64;
  rows.push({ ...r, notes: `${r.notes.bells} bells, ${r.notes.arpeggios} arps, ${r.notes.chords} chords` });
}
console.table(rows);
if (out) console.log('wrote', `${out}/ambient-p035.wav`);
close();
