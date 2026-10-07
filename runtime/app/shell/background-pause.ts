import { Application } from '@nativescript/core';

/**
 * Pause a native stream while the app is backgrounded, resume it on foreground. For sensor streams
 * (motion…) the PWA opened and may never stop itself: without this, the native poll keeps firing
 * evaluateJavaScript into a hidden WebView (battery + CPU for frames nobody renders).
 * `pause`/`resume` are only called while `active()` — i.e. the PWA still holds the stream. `resume`
 * must be idempotent: iOS resumeEvent also fires on inactive→active with no prior suspend. If it
 * throws, `onResumeError` resets the caller's state so a later start isn't blocked.
 */
export function pauseInBackground(
  active: () => boolean,
  pause: () => void,
  resume: () => void,
  onResumeError: () => void
): void {
  Application.on(Application.suspendEvent, () => { if (active()) pause(); });
  Application.on(Application.resumeEvent, () => {
    if (!active()) return;
    try {
      resume();
    } catch (e) {
      console.warn('AppWrap: stream resume failed', e);
      onResumeError();
    }
  });
}
