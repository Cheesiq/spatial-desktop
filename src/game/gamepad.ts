/**
 * Game controllers through the browser's Gamepad API: Xbox, PlayStation,
 * Switch Pro and Android Bluetooth pads all report the "standard" layout.
 * (In VR the controllers come through WebXR instead; see game.ts.)
 *
 *   Left stick   move          Right stick   aim
 *   RT           fire          LT            shield
 *   RB / Y       nova          Start         pause
 *   A            engage, resume, fight again
 *   B            back (out of pause, or to the desktop from a menu)
 */

// Standard-mapping button indices.
const A = 0;
const B = 1;
const Y = 3;
const RB = 5;
const LT = 6;
const RT = 7;
const START = 9;
const DEAD = 0.16;

export interface PadState {
  move: { x: number; y: number };
  aim: { x: number; y: number };
  fire: boolean;
  shield: boolean;
  /** Pressed this frame. */
  pressed: { a: boolean; b: boolean; nova: boolean; start: boolean };
}

/** Radial deadzone, rescaled so motion starts smoothly at its edge. */
function stick(x: number, y: number): { x: number; y: number } {
  const d = Math.hypot(x, y);
  if (d < DEAD) return { x: 0, y: 0 };
  const k = Math.min(1, (d - DEAD) / (1 - DEAD)) / d;
  return { x: x * k, y: y * k };
}

export class Pads {
  private previous: boolean[] = [];
  private pad: Gamepad | null = null;
  /** True from the first input on a controller until the screen is touched or the mouse used. */
  inUse = false;

  /** Read the most recently used controller; null when none is connected. */
  poll(): PadState | null {
    const pads = navigator.getGamepads?.() ?? [];
    let pad: Gamepad | null = null;
    for (const candidate of pads) {
      if (candidate?.connected && candidate.mapping === 'standard' && (!pad || candidate.timestamp > pad.timestamp)) pad = candidate;
    }
    this.pad = pad;
    if (!pad) {
      this.previous = [];
      return null;
    }
    const held = pad.buttons.map((button, i) => button.pressed || button.value > (i === LT || i === RT ? 0.3 : 0.5));
    const previous = this.previous;
    this.previous = held;
    const edge = (i: number) => (held[i] ?? false) && !(previous[i] ?? false);
    const state: PadState = {
      move: stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0),
      aim: stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0),
      fire: held[RT] ?? false,
      shield: held[LT] ?? false,
      pressed: { a: edge(A), b: edge(B), nova: edge(RB) || edge(Y), start: edge(START) },
    };
    if (held.some(Boolean) || Math.hypot(state.move.x, state.move.y, state.aim.x, state.aim.y) > 0) this.inUse = true;
    return state;
  }

  /** A short rumble, 0..1 per motor; ignored by pads without one. */
  rumble(strong: number, weak: number, ms: number): void {
    const actuator = (this.pad as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }) | null)?.vibrationActuator;
    actuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }
}
