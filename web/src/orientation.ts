/**
 * Keep the app chrome portrait while the phone is physically repositioned.
 *
 * Installed PWAs may honour the manifest before JavaScript starts. The API is
 * still useful after returning from another app, and on browsers that permit
 * orientation locking in standalone/fullscreen contexts. Browsers are allowed
 * to reject it (notably iPhone Safari), so failure is intentionally silent:
 * workout startup must never depend on a presentation preference.
 */

export async function lockPortrait(): Promise<boolean> {
  const orientation = window.screen.orientation;
  if (!orientation || typeof orientation.lock !== 'function') return false;

  try {
    await orientation.lock('portrait-primary');
    return true;
  } catch {
    return false;
  }
}

/** Re-apply the lock whenever an installed app returns to the foreground. */
export function installPortraitLock(): void {
  void lockPortrait();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void lockPortrait();
  });
  window.addEventListener('pageshow', () => void lockPortrait());
}
