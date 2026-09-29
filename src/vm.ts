import type { PanelSource } from './source.js';
import { connectVnc } from './vnc.js';

/**
 * Connect to Omarchy's Windows VM display through the dev server's /vm-vnc
 * proxy (see vite.config.ts), which adds the VM's credentials server-side.
 */
export async function connectVm(): Promise<PanelSource> {
  const vnc = await connectVnc('/vm-vnc', 'Windows VM', {
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
