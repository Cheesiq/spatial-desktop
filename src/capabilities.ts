/** What this install can do; the page offers only the features that work here. */
export interface Capabilities {
  /** A Spatial Desktop server is behind the page (dev server or desktop app), not static hosting. */
  server: boolean;
  /** Hyprland session with the Hyprland panel available. */
  hyprland: boolean;
  /** Omarchy's app search, on the Hyprland panel. */
  search: boolean;
  /** Omarchy's Windows VM is set up. */
  windowsVm: boolean;
  /** The macOS VM (~/.local/bin/macos-vm) is set up. */
  macosVm: boolean;
  /** Any launcher apps are installed. */
  launcher: boolean;
  /** The browser can capture windows or screens (not in Android's WebView). */
  windowCapture: boolean;
}

/**
 * Ask the server what's available. Static hosting (the web version, the
 * Android app) has no /api, which leaves the standalone scene: panels from
 * window capture where the browser supports it, and everything else local.
 */
export async function detectCapabilities(): Promise<Capabilities> {
  const windowCapture = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const standalone = { server: false, hyprland: false, search: false, windowsVm: false, macosVm: false, launcher: false, windowCapture };
  try {
    const response = await fetch('/api/capabilities', { cache: 'no-store' });
    const found = (await response.json()) as Partial<Capabilities>;
    if (!response.ok || typeof found.hyprland !== 'boolean') return standalone;
    return {
      server: true,
      hyprland: found.hyprland,
      search: found.search === true,
      windowsVm: found.windowsVm === true,
      macosVm: found.macosVm === true,
      launcher: found.launcher === true,
      windowCapture,
    };
  } catch {
    // An HTML page (static hosting's fallback) or no network at all.
    return standalone;
  }
}
