/**
 * Claude workers: Claude Code sessions, each running in its own tmux session
 * on a private tmux server, shown in a terminal window (on the Hyprland panel
 * when it's open). Because tmux owns each session, a worker keeps running when
 * its window closes, and dictated text goes straight into it with
 * `tmux send-keys`, without moving the cursor or focus away from the scene.
 *
 * Dictation: the page records the microphone and posts 16 kHz mono WAV;
 * voxtype (Omarchy's local speech-to-text) transcribes it on this machine and
 * the text is typed into the current worker. Nothing leaves the computer.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Host, reply } from './host.js';
import { launchOnPanel } from './hyprland.js';

const run = promisify(execFile);
/** A tmux server of our own, so the user's tmux sessions are never touched. */
const TMUX = ['-L', 'spatial-claude'];
const SESSION = /^worker-(\d+)$/;
/** Where new workers start; SPATIAL_CLAUDE_DIR overrides it. */
const WORKDIR = process.env.SPATIAL_CLAUDE_DIR ?? join(homedir(), 'Work');
/** 60 s of 16 kHz 16-bit mono WAV, with room for the header. */
const MAX_AUDIO = 60 * 16000 * 2 + 1024;

export interface Worker {
  id: number;
  name: string;
}

const tmux = (...args: string[]) => run('tmux', [...TMUX, ...args], { timeout: 5000 });
const session = (id: number) => `worker-${id}`;
const appId = (id: number) => `spatial.claude.${id}`;

async function listWorkers(): Promise<Worker[]> {
  try {
    const { stdout } = await tmux('list-sessions', '-F', '#{session_name}');
    return stdout
      .split('\n')
      .map((name) => SESSION.exec(name)?.[1])
      .filter((id): id is string => id != null)
      .map(Number)
      .sort((a, b) => a - b)
      .map((id) => ({ id, name: `Claude ${id}` }));
  } catch {
    return []; // No tmux server yet: no workers.
  }
}

/** A terminal attached to the worker, on the Hyprland panel if it's open. */
async function openTerminal(id: number, log: Host['log']): Promise<void> {
  const command = ['omarchy-launch-tui', `--app-id=${appId(id)}`, 'tmux', ...TMUX, 'attach-session', '-t', session(id)];
  if (await launchOnPanel(command).catch(() => false)) return;
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' });
  child.once('error', (error) => log.error(`[claude] terminal for worker ${id}: ${error.message}`));
  child.unref();
}

/** Whether the worker's terminal window is open anywhere in Hyprland. */
async function hasTerminal(id: number): Promise<boolean> {
  try {
    const { stdout } = await run('hyprctl', ['-j', 'clients'], { timeout: 2000 });
    return (JSON.parse(stdout) as Array<{ class: string }>).some((client) => client.class === appId(id));
  } catch {
    return false;
  }
}

/** Speech to text with voxtype, locally. */
async function transcribe(wav: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spatial-dictation-'));
  try {
    const file = join(dir, 'speech.wav');
    await writeFile(file, wav);
    const { stdout } = await run('voxtype', ['--quiet', 'transcribe', file], { timeout: 120_000 });
    return stdout.trim().replace(/\s+/g, ' ');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) return req.destroy(new Error('Too large'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Mount /api/claude/*. Everything that starts a worker or types into one is
 * POST-only and same-origin (see attachLauncher in server/features.ts).
 */
export function attachClaude(host: Host, canRun: (program: string) => boolean): void {
  /** The worker that dictation and Send go to: the newest one, or the one last tapped. */
  let current: number | null = null;
  const currentWorker = async () => {
    const workers = await listWorkers();
    if (!workers.some((w) => w.id === current)) current = workers.at(-1)?.id ?? null;
    return { workers, current };
  };

  const guarded =
    (type: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
      if (!host.origins.has(req.headers.origin ?? '')) return reply(res, 403, { error: 'Forbidden origin' });
      if (!req.headers['content-type']?.startsWith(type)) return reply(res, 415, { error: `${type} only` });
      handler(req, res).catch((error: Error) => res.writableEnded || reply(res, 500, { error: error.message }));
    };
  const idFrom = async (req: IncomingMessage) => {
    const body = JSON.parse(String(await readBody(req, 1024)) || '{}') as { id?: unknown };
    return typeof body.id === 'number' && Number.isInteger(body.id) ? body.id : null;
  };

  host.use('/api/claude/workers', (req, res) => void currentWorker().then((state) => reply(res, 200, state)));

  host.use(
    '/api/claude/spawn',
    guarded('application/json', async (req, res) => {
      if (!canRun('claude')) return reply(res, 404, { error: 'Claude Code is not installed' });
      const { workers } = await currentWorker();
      const id = (workers.at(-1)?.id ?? 0) + 1;
      await tmux('new-session', '-d', '-s', session(id), '-c', WORKDIR, '-x', '160', '-y', '48', 'claude');
      current = id;
      await openTerminal(id, host.log);
      reply(res, 200, { id, name: `Claude ${id}` });
    }),
  );

  // Make a worker the current one, reopening its terminal if it was closed.
  host.use(
    '/api/claude/select',
    guarded('application/json', async (req, res) => {
      const id = await idFrom(req);
      const { workers } = await currentWorker();
      if (!workers.some((w) => w.id === id)) return reply(res, 404, { error: 'No such worker' });
      current = id;
      if (!(await hasTerminal(id!))) await openTerminal(id!, host.log);
      reply(res, 200, { current });
    }),
  );

  // Press Enter in the current worker, e.g. to send what was dictated.
  host.use(
    '/api/claude/submit',
    guarded('application/json', async (req, res) => {
      const { current } = await currentWorker();
      if (current == null) return reply(res, 409, { error: 'No Claude worker is running' });
      await tmux('send-keys', '-t', session(current), 'Enter');
      reply(res, 200, { worker: current });
    }),
  );

  // Body: 16 kHz mono WAV. ?submit=1 also presses Enter after the text.
  host.use(
    '/api/claude/dictate',
    guarded('audio/wav', async (req, res) => {
      if (!canRun('voxtype')) return reply(res, 404, { error: 'voxtype is not installed' });
      const submit = new URL(req.url ?? '/', 'http://x').searchParams.get('submit') === '1';
      const wav = await readBody(req, MAX_AUDIO);
      const { current } = await currentWorker();
      if (current == null) return reply(res, 409, { error: 'No Claude worker is running' });
      const text = await transcribe(wav);
      if (!text) return reply(res, 200, { text: '', worker: current });
      // -l types the text literally: no key names, nothing a shell interprets.
      // A trailing space keeps the next dictation from running into this one.
      await tmux('send-keys', '-t', session(current), '-l', submit ? text : `${text} `);
      if (submit) await tmux('send-keys', '-t', session(current), 'Enter');
      reply(res, 200, { text, worker: current });
    }),
  );
}
