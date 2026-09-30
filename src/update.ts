/**
 * The Android app is a sideloaded APK, so it can't update itself. When it's
 * running as that app, ask GitHub for the latest release and, if it's newer
 * than this build, offer the new APK. (The desktop apps update themselves:
 * electron/updates.mjs. The web version is always current.)
 */
const LATEST = 'https://api.github.com/repos/Cheesiq/spatial-desktop/releases/latest';
const APK = 'https://github.com/Cheesiq/spatial-desktop/releases/latest/download/Spatial-Desktop-android.apk';

/** True when `latest` (e.g. "v1.3.0") is a newer version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

const inAndroidApp = () =>
  (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;

/** Resolves with the newer version and where to get it, or null. */
export async function checkForAppUpdate(): Promise<{ version: string; url: string } | null> {
  if (!inAndroidApp()) return null;
  try {
    const response = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const { tag_name: tag } = (await response.json()) as { tag_name?: string };
    if (!tag || !isNewer(tag, __APP_VERSION__)) return null;
    return { version: tag.replace(/^v/, ''), url: APK };
  } catch {
    // Offline; the next launch will look again.
    return null;
  }
}
