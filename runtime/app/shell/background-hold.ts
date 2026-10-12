/**
 * Keep the WebView's JS + render pipeline running while the app is backgrounded / the screen is locked.
 * By default the shell pauses it on suspend (Android: WebView.onPause + pauseTimers — every page timer, socket
 * handler and promise stops). A module whose work is the page's own JS — e.g. a voice call: page websocket STT,
 * TTS playback, mic capture — holds it for as long as that work is live. Keyed, so holders don't release each other.
 */
const holds = new Set<string>();
let onRelease: (() => void) | null = null;

export function holdBackgroundRun(key: string, on: boolean): void {
  if (on) { holds.add(key); return; }
  if (holds.delete(key) && !holds.size) onRelease?.();
}

export const backgroundRunHeld = (): boolean => holds.size > 0;

/** main-page: run when the last hold goes (it applies the skipped pause if the app is still backgrounded). */
export function onBackgroundRunReleased(fn: () => void): void { onRelease = fn; }
