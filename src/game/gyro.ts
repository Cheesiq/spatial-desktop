import { Euler, Quaternion, Vector3 } from '@iwsdk/core';

/**
 * Look-around aiming for phones and tablets, like Stellarium's sensor mode:
 * the phone is a window into the scene. Point it up and you look up; turn
 * around and you see behind you. It follows the device's orientation (the
 * OS's fused gyroscope + accelerometer), not a rate, so the view stays locked
 * to where the phone points and never drifts off.
 *
 * Which way counts as "ahead" is up to the game: it re-centres on the view
 * when gyro aiming starts, and a horizontal drag moves it, so you can turn
 * without turning your body.
 */

const STORE_KEY = 'rogue-protocol.gyro';
const D = Math.PI / 180;
/** -90° about X: the camera looks out of the back of the phone. */
const BACK = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const Z_AXIS = new Vector3(0, 0, 1);
const euler = new Euler();
const q = new Quaternion();
const screenTurn = new Quaternion();

export class Gyro {
  /** The device reports its orientation (known after the first reading). */
  available = false;
  private latest: { yaw: number; pitch: number } | null = null;
  private listening = false;
  private readonly onOrientation = (event: DeviceOrientationEvent) => this.read(event);

  /** The player's choice; on unless they've turned it off. */
  get enabled(): boolean {
    try {
      return localStorage.getItem(STORE_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  set enabled(on: boolean) {
    try {
      localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
    } catch {
      // Not remembered; fine.
    }
  }

  start(): void {
    if (this.listening || typeof DeviceOrientationEvent === 'undefined') return;
    this.listening = true;
    window.addEventListener('deviceorientation', this.onOrientation);
  }

  stop(): void {
    this.listening = false;
    this.latest = null;
    window.removeEventListener('deviceorientation', this.onOrientation);
  }

  /** iOS asks before sharing motion; call from a tap. Elsewhere this does nothing. */
  requestPermission(): void {
    const ask = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    ask?.call(DeviceOrientationEvent).catch(() => {});
  }

  /**
   * Where the phone points, as view yaw (left +, radians, relative to an
   * arbitrary heading) and pitch (up +). Roll is left out so the horizon stays level.
   */
  get view(): { yaw: number; pitch: number } | null {
    return this.latest;
  }

  private read(event: DeviceOrientationEvent): void {
    if (event.alpha == null || event.beta == null || event.gamma == null) return;
    this.available = true;
    const angle = screen.orientation?.angle ?? Number((window as { orientation?: number }).orientation ?? 0);
    q.setFromEuler(euler.set(event.beta * D, event.alpha * D, -event.gamma * D, 'YXZ'))
      .multiply(BACK)
      .multiply(screenTurn.setFromAxisAngle(Z_AXIS, -angle * D));
    euler.setFromQuaternion(q, 'YXZ');
    this.latest = { yaw: euler.y, pitch: euler.x };
  }
}
