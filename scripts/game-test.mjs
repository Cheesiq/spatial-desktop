// Rogue Protocol against the headless browser:
//   CDP_PORT=9225 APP_ORIGIN=http://localhost:5180 node scripts/game-test.mjs <out-dir>
// Opens the game, lets the autopilot play a few waves (including the
// Overseer), checks damage, game over and the way back to the desktop, and
// saves screenshots along the way.
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2] ?? '.';
const { js, send, sleep, reload, close } = await connect();
const shot = async (name) =>
  writeFileSync(`${out}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
const errors = [];
await send('Runtime.enable');
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};
const state = () => js('spatial.game.debug()');

await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await reload();
await sleep(1500);
await js(`window.__errors = []; addEventListener('error', (e) => __errors.push(String(e.message))); true`);

// Open from the keyboard shortcut.
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'g', code: 'KeyG', text: 'g' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'g', code: 'KeyG' });
await sleep(2500);
let s = await state();
check('G opens the title screen', (await js('spatial.game.active')) && s.phase === 'title', JSON.stringify({ phase: s.phase, bots: s.bots.length }));
check('desktop control bar hidden', await js(`getComputedStyle(document.getElementById('hud')).display === 'none'`));
await shot('01-title');

// Keys that are desktop shortcuts must not leak while playing.
await js(`spatial.game.autopilot = true; spatial.game.god = true; spatial.game.engage(); true`);
await sleep(600);
s = await state();
check('engage starts wave 1', s.phase === 'playing' && s.wave === 1, JSON.stringify({ phase: s.phase, wave: s.wave }));
await sleep(5500);
await shot('02-wave1');
s = await state();
check('bots spawned', s.bots.length > 0, `${s.bots.length} bots`);
await sleep(9000);
s = await state();
check('autopilot scores', s.score > 0, `score ${s.score}, wave ${s.wave}`);
await shot('03-fight');

// Wait for a wave clear and the jump.
for (let i = 0; i < 60 && !(await state()).jumping; i++) await sleep(500);
await sleep(1200);
s = await state();
check('wave clear jumps to the next sector', s.jumping || s.wave >= 2, JSON.stringify({ wave: s.wave, sector: s.sector, jumping: s.jumping }));
await shot('04-warp');

// The Overseer.
await js(`spatial.game.skipTo(5); true`);
await sleep(7000);
s = await state();
check('wave 5 brings the Overseer and its nodes', s.bots.some((b) => b.kind === 'overseer') && s.bots.filter((b) => b.kind === 'node').length === 4, s.bots.map((b) => b.kind).join(','));
await shot('05-overseer');
await sleep(12000);
await shot('06-overseer-fight');

// Taking damage, then game over.
await js(`spatial.game.god = false; spatial.game.autopilot = false; true`);
const hullBefore = (await state()).hull;
for (let i = 0; i < 80 && (await state()).phase === 'playing'; i++) await sleep(500);
s = await state();
check('bots hurt you and the run ends', s.hull < hullBefore && s.phase === 'over', JSON.stringify({ hull: s.hull, phase: s.phase }));
await sleep(1200);
await shot('07-game-over');

// Back to the desktop.
await js(`document.querySelectorAll('.rp-menu .rp-btn')[1].click(); true`);
await sleep(800);
check('back to desktop', !(await js('spatial.game.active')) && (await js(`getComputedStyle(document.getElementById('hud')).display !== 'none'`)));
check('camera restored', await js(`(() => { const c = spatial.world.camera; return Math.abs(c.position.y - 1.6) < 0.01 && Math.abs(c.fov - 50) < 5; })()`), await js(`JSON.stringify({ y: spatial.world.camera.position.y, fov: spatial.world.camera.fov })`));
const pageErrors = await js('__errors');
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await shot('08-desktop');
close();
