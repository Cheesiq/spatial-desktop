import type { PanelSource } from './source.js';
import { connectVnc } from './vnc.js';

/** The VMs, each proxied by the server (server/features.ts), which adds its credentials. */
export const VMS = {
  windows: { route: '/vm-vnc', label: 'Windows VM' },
  macos: { route: '/macos-vnc', label: 'macOS VM' },
} as const;
export type VmId = keyof typeof VMS;

/** Connect to a VM's display through its server-side proxy. */
export async function connectVm(id: VmId): Promise<PanelSource> {
  const vnc = await connectVnc(VMS[id].route, VMS[id].label, {
    securityFailure: 'The VM rejected the VNC login',
    closed: 'The VM closed the connection',
    unreachable: 'Could not reach the VM display (is it running?)',
  });
  const { source, rfb, canvas } = vnc;
  source.input = {
    pointer: vnc.pointer,
    wheel: vnc.wheel,
    // noVNC's own keyboard handler lives on its canvas, so focusing it
    // routes real key events (with correct keysyms) to the VM.
    focusKeyboard: () => rfb.focus({ preventScroll: true }),
    releaseKeyboard: () => rfb.blur(),
    hasKeyboard: () => document.activeElement === canvas,
  };
  return source;
}
