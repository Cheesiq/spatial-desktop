/**
 * On-screen controls for phones and tablets. A joystick appears under your
 * left thumb wherever it lands; dragging anywhere else aims; FIRE, SHIELD,
 * NOVA and pause sit under the right thumb. Everything fades away a few
 * seconds after your last touch and comes back with the next one.
 *
 * The layer sets `touch-action: none`, which is what keeps the browser from
 * taking a drag as a scroll gesture and cancelling it (the 1.2.0 bug).
 */

type Zone = 'stick' | 'aim' | 'fire' | 'shield' | 'nova' | 'pause' | 'gyro';

interface Finger {
  zone: Zone;
  x: number;
  y: number;
  /** Where the joystick was planted. */
  ox: number;
  oy: number;
}

const STICK_RADIUS = 56;
const FADE_AFTER = 3;

export interface TouchActions {
  nova: () => void;
  pause: () => void;
  /** Turn gyro aiming on or off. */
  gyro: () => void;
}

export class TouchControls {
  readonly root = document.createElement('div');
  /** Joystick direction, each axis -1..1 (y is down the screen). */
  readonly move = { x: 0, y: 0 };
  firing = false;
  shielding = false;
  private aimX = 0;
  private aimY = 0;
  private readonly fingers = new Map<number, Finger>();
  private readonly stick = document.createElement('div');
  private readonly knob = document.createElement('div');
  private readonly buttons = new Map<Zone, HTMLElement>();
  private idle = 0;
  private shown = false;

  constructor(private readonly actions: TouchActions) {
    this.root.className = 'rp-touchpad';
    this.root.hidden = true;
    this.stick.className = 'rp-stick';
    this.knob.className = 'rp-knob';
    this.stick.append(this.knob);
    this.root.append(this.stick);
    const icon = {
      fire: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
      shield: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3z"/></svg>',
      nova: '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>',
      pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
      gyro: '<svg viewBox="0 0 24 24"><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v14h10V5H7z"/><path d="M2 12a10 10 0 0 1 3-7M22 12a10 10 0 0 1-3 7" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
    };
    for (const zone of ['fire', 'shield', 'nova', 'pause', 'gyro'] as const) {
      const button = document.createElement('div');
      button.className = `rp-tbtn rp-t-${zone}`;
      button.dataset.zone = zone;
      button.innerHTML = `${icon[zone]}<span>${zone === 'pause' ? '' : zone.toUpperCase()}</span>`;
      if (zone === 'gyro') button.hidden = true;
      this.root.append(button);
      this.buttons.set(zone, button);
    }

    const opts = { passive: false } as const;
    this.root.addEventListener('pointerdown', (e) => this.down(e), opts);
    this.root.addEventListener('pointermove', (e) => this.moveTo(e), opts);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      this.root.addEventListener(type, (e) => this.up(e));
    }
    // No long-press menu or text selection under a held thumb.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(this.root);
  }

  /** Shown while playing on a touch screen; hidden in menus, VR and with a controller. */
  set active(active: boolean) {
    if (active === !this.root.hidden) return;
    this.root.hidden = !active;
    if (!active) this.reset();
    else this.wake();
  }

  get active(): boolean {
    return !this.root.hidden;
  }

  /** The GYRO button: hidden without a gyroscope, lit while gyro aiming is on. */
  showGyro(available: boolean, on: boolean): void {
    const button = this.buttons.get('gyro')!;
    button.hidden = !available;
    button.classList.toggle('rp-lit', on);
    button.setAttribute('aria-pressed', String(on));
  }

  /** Aim movement since the last call, in CSS pixels. */
  takeAim(): { dx: number; dy: number } {
    const aim = { dx: this.aimX, dy: this.aimY };
    this.aimX = this.aimY = 0;
    return aim;
  }

  /** Fades the controls out after a while without a touch. */
  update(dt: number): void {
    if (this.root.hidden) return;
    this.idle = this.fingers.size ? 0 : this.idle + dt;
    const show = this.idle < FADE_AFTER;
    if (show !== this.shown) {
      this.shown = show;
      this.root.classList.toggle('rp-faded', !show);
    }
  }

  private wake(): void {
    this.idle = 0;
    this.shown = true;
    this.root.classList.remove('rp-faded');
  }

  private reset(): void {
    this.fingers.clear();
    this.move.x = this.move.y = 0;
    this.firing = this.shielding = false;
    this.aimX = this.aimY = 0;
    this.stick.classList.remove('rp-on');
    for (const button of this.buttons.values()) button.classList.remove('rp-held');
  }

  private zoneAt(e: PointerEvent): Zone {
    const button = (e.target as Element).closest?.<HTMLElement>('.rp-tbtn');
    if (button) return button.dataset.zone as Zone;
    // Left 40% of the screen is the joystick; everywhere else aims.
    return e.clientX < innerWidth * 0.4 ? 'stick' : 'aim';
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    this.wake();
    const zone = this.zoneAt(e);
    this.root.setPointerCapture(e.pointerId);
    this.fingers.set(e.pointerId, { zone, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY });
    if (zone === 'stick') {
      this.stick.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.knob.style.transform = '';
      this.stick.classList.add('rp-on');
    }
    if (zone === 'fire') this.firing = true;
    if (zone === 'shield') this.shielding = true;
    if (zone === 'nova') this.actions.nova();
    if (zone === 'pause') this.actions.pause();
    if (zone === 'gyro') this.actions.gyro();
    this.buttons.get(zone)?.classList.add('rp-held');
  }

  private moveTo(e: PointerEvent): void {
    const finger = this.fingers.get(e.pointerId);
    if (!finger) return;
    e.preventDefault();
    const dx = e.clientX - finger.x;
    const dy = e.clientY - finger.y;
    finger.x = e.clientX;
    finger.y = e.clientY;
    if (finger.zone === 'stick') {
      let sx = e.clientX - finger.ox;
      let sy = e.clientY - finger.oy;
      const d = Math.hypot(sx, sy);
      if (d > STICK_RADIUS) {
        sx *= STICK_RADIUS / d;
        sy *= STICK_RADIUS / d;
      }
      this.move.x = sx / STICK_RADIUS;
      this.move.y = sy / STICK_RADIUS;
      this.knob.style.transform = `translate(${sx}px, ${sy}px)`;
      return;
    }
    // Aim from the open screen, and from FIRE too, so one thumb can aim while shooting.
    if (finger.zone === 'aim' || finger.zone === 'fire') {
      this.aimX += dx;
      this.aimY += dy;
    }
  }

  private up(e: PointerEvent): void {
    const finger = this.fingers.get(e.pointerId);
    if (!finger) return;
    this.fingers.delete(e.pointerId);
    const still = (zone: Zone) => [...this.fingers.values()].some((f) => f.zone === zone);
    if (finger.zone === 'stick' && !still('stick')) {
      this.move.x = this.move.y = 0;
      this.stick.classList.remove('rp-on');
    }
    if (finger.zone === 'fire') this.firing = still('fire');
    if (finger.zone === 'shield') this.shielding = still('shield');
    if (!still(finger.zone)) this.buttons.get(finger.zone)?.classList.remove('rp-held');
  }
}
