import type { PanelSource, ScreenQuad } from './source.js';
import { connectVnc } from './vnc.js';

export const HYPRLAND_LABEL = 'Hyprland';

/** KeyboardEvent.code to Linux evdev key codes (xkb keycode = evdev + 8). */
const EVDEV: Record<string, number> = {
  Escape: 1, Minus: 12, Equal: 13, Backspace: 14, Tab: 15, BracketLeft: 26, BracketRight: 27, Enter: 28,
  Semicolon: 39, Quote: 40, Backquote: 41, Backslash: 43, Comma: 51, Period: 52, Slash: 53, Space: 57,
  CapsLock: 58, NumLock: 69, ScrollLock: 70, IntlBackslash: 86, ContextMenu: 127,
  NumpadMultiply: 55, NumpadSubtract: 74, NumpadAdd: 78, NumpadDecimal: 83, NumpadEnter: 96, NumpadDivide: 98,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108,
  PageDown: 109, Insert: 110, Delete: 111,
  F11: 87, F12: 88,
};
[...'1234567890'].forEach((digit, i) => (EVDEV[`Digit${digit}`] = 2 + i));
['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'].forEach((row, r) =>
  [...row].forEach((letter, i) => (EVDEV[`Key${letter}`] = [16, 30, 44][r] + i)),
);
for (let i = 1; i <= 10; i++) EVDEV[`F${i}`] = 58 + i;
[71, 72, 73, 75, 76, 77, 79, 80, 81].forEach((code, i) => (EVDEV[`Numpad${[7, 8, 9, 4, 5, 6, 1, 2, 3][i]}`] = code));
EVDEV.Numpad0 = 82;

const post = async (path: string, body: object = {}) => {
  const response = await fetch(`/api/hyprland/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error ?? response.statusText));
  return result;
};

/** Open Omarchy's app search on the panel and hand the real mouse and keyboard to it. */
export const searchOnPanel = (quad: ScreenQuad) => post('search', { quad });

/**
 * Hyprland's own virtual monitor as a panel (see server/hyprland.ts). With the
 * mouse, clicking it moves the real cursor and keyboard in; with an XR ray,
 * clicks are replayed through VNC and keys forwarded to the clicked window.
 */
export async function connectHyprland(onChange: () => void): Promise<PanelSource> {
  await post('start');
  const vnc = await connectVnc('/hyprland-vnc', HYPRLAND_LABEL, {
    securityFailure: 'wayvnc refused the connection',
    closed: 'wayvnc closed the connection',
    unreachable: 'Could not reach wayvnc',
  });
  const { source } = vnc;

  // Whether the real cursor is on the virtual monitor, and whether a clicked
  // window can take forwarded keys.
  let inside = false;
  let keyTarget = false;
  const events = new EventSource('/api/hyprland/events');
  events.onmessage = (event) => {
    ({ inside, keyTarget } = JSON.parse(event.data) as { inside: boolean; keyTarget: boolean });
    onChange();
  };

  // Hyprland maps wayvnc's absolute motion onto the wrong monitor, so the
  // server positions the cursor and VNC only carries buttons and wheel, always
  // at (0, 0), where wayvnc sends no motion (see server/hyprland.ts).
  const sendButtons = (mask: number) => vnc.pointer(0, 0, mask);

  // XR ray clicks are buffered press-to-release and replayed in one go, so
  // the shared desktop cursor is only borrowed for a moment (no hover).
  let gesture: Array<[number, number, number]> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const borrowed = (u: number, v: number, work: () => Promise<void> | void) => {
    queue = queue
      .then(() => post('borrow', { u, v }))
      .then(work)
      .then(() => post('return'))
      .catch((error: Error) => console.warn('[hyprland]', error.message));
  };

  let keyboard = false;
  const onKey = (event: KeyboardEvent) => {
    if (!keyboard || !keyTarget || event.type !== 'keydown') return;
    const code = EVDEV[event.code];
    if (code == null) return; // Modifiers travel as `mods` with each key.
    event.preventDefault();
    event.stopPropagation();
    const mods = [event.shiftKey && 'SHIFT', event.ctrlKey && 'CTRL', event.altKey && 'ALT', event.metaKey && 'SUPER'].filter(Boolean);
    queue = queue.then(() => post('key', { code: code + 8, mods }).then(() => {}, () => {}));
  };
  window.addEventListener('keydown', onKey, true);

  const dispose = source.dispose;
  source.dispose = () => {
    window.removeEventListener('keydown', onKey, true);
    events.close();
    if (inside) void post('leave').catch(() => {});
    dispose();
  };

  source.input = {
    pointer(u, v, buttons) {
      if (!gesture && !buttons) return;
      gesture ??= [];
      if (gesture.length < 500) gesture.push([u, v, buttons]);
      if (buttons) return;
      const [press, ...rest] = gesture;
      gesture = null;
      // A drag keeps its path, thinned to at most ~30 steps.
      const moves = rest.filter((_, i) => i === rest.length - 1 || i % Math.ceil(rest.length / 30) === 0);
      borrowed(press[0], press[1], async () => {
        sendButtons(press[2]);
        for (const [u, v, b] of moves) {
          await post('point', { u, v });
          sendButtons(b);
        }
      });
    },
    wheel(u, v, deltaX, deltaY) {
      borrowed(u, v, () => vnc.wheel(0, 0, deltaX, deltaY));
    },
    focusKeyboard: () => {
      keyboard = true;
      onChange();
    },
    releaseKeyboard: () => {
      keyboard = false;
      onChange();
    },
    // Only claim the keyboard when keys have somewhere to go, so the scene's
    // shortcuts keep working after clicking the empty desktop.
    hasKeyboard: () => inside || (keyboard && keyTarget),
    enter(u, v, quad) {
      queue = queue
        .then(() => post('enter', { u, v, quad }))
        // The click that entered also lands, e.g. on a button or a window.
        .then(() => {
          sendButtons(1);
          sendButtons(0);
        })
        .catch((error: Error) => console.warn('[hyprland]', error.message));
    },
    hint: () =>
      inside
        ? 'Mouse & keyboard → Hyprland · push the cursor off its left, right or bottom edge to come back'
        : null,
  };
  return source;
}
