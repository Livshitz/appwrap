/**
 * Background-launch context seam — a tiny always-bundled module so the (always-on) `app.handshake`
 * handler can report a wake id WITHOUT importing the strippable `handlers-background` file (which only
 * lands when the `backgroundTask` module is active). The headless runner sets the id before loading
 * the offscreen WebView; the handshake reads it ONCE (so a foreground handshake later in the same
 * process never re-reports a stale wake). No NativeScript globals → also unit-testable.
 */
let pendingBackgroundTaskId: string | null = null;

/** Set by the headless background runner before it loads the offscreen WebView for `id`. */
export function setPendingBackgroundTaskId(id: string | null): void {
  pendingBackgroundTaskId = id;
}

/** Read-and-clear the pending wake id (called by the handshake handler). */
export function consumePendingBackgroundTaskId(): string | null {
  const id = pendingBackgroundTaskId;
  pendingBackgroundTaskId = null;
  return id;
}
