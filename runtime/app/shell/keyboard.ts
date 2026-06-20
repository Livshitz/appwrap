import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

declare const android: any;
// iOS keyboard-notification globals (marshalled from UIKit at runtime).
declare const NSNotificationCenter: any;
declare const UIKeyboardWillShowNotification: string;
declare const UIKeyboardWillHideNotification: string;
declare const UIKeyboardFrameEndUserInfoKey: string;

let observersArmed = false;

/**
 * `kit.keyboard` shell handlers: dismiss the software keyboard (`keyboard.hide`)
 * and forward show/hide so the page can lift content above it.
 *
 * Heights are emitted in CSS px — iOS keyboard frames are in points (≈ CSS px in
 * a WKWebView), Android raw pixels are divided by display density. iOS observes
 * `UIKeyboardWillShow/Hide`; Android watches the decor view's visible frame.
 */
export function registerKeyboardHandlers(): void {
  bridge.register('keyboard.hide', () => {
    Utils.dispatchToMainThread(() => {
      if (isIOS) {
        // WKWebView is a UIView → endEditing resigns the active field's first responder.
        (bridge.getWebView()?.ios as any)?.endEditing?.(true);
      } else if (isAndroid) {
        hideAndroidKeyboard();
      }
    });
  });

  if (observersArmed) return;
  observersArmed = true;
  if (isIOS) armIosKeyboardObservers();
  else if (isAndroid) armAndroidKeyboardObserver();
}

/** iOS: NSNotificationCenter observers → emit keyboard.show {height} / keyboard.hide. */
function armIosKeyboardObservers(): void {
  const center = NSNotificationCenter.defaultCenter;
  center.addObserverForNameObjectQueueUsingBlock(UIKeyboardWillShowNotification, null, null, (note: any) => {
    const value = note?.userInfo?.objectForKey?.(UIKeyboardFrameEndUserInfoKey);
    const height = value ? value.CGRectValue.size.height : 0; // points ≈ CSS px in WKWebView
    bridge.emit('keyboard.show', { height: Math.round(height) });
  });
  center.addObserverForNameObjectQueueUsingBlock(UIKeyboardWillHideNotification, null, null, () => {
    bridge.emit('keyboard.hide');
  });
}

/** Android: a global-layout listener compares the decor view's visible frame to its full height. */
function armAndroidKeyboardObserver(): void {
  const activity = androidActivity();
  if (!activity) return;
  const rootView = activity.getWindow().getDecorView();
  const density = Utils.android.getApplicationContext().getResources().getDisplayMetrics().density || 1;
  let lastShown = false;
  const listener = new android.view.ViewTreeObserver.OnGlobalLayoutListener({
    onGlobalLayout() {
      const rect = new android.graphics.Rect();
      rootView.getWindowVisibleDisplayFrame(rect);
      const screenHeight = rootView.getHeight();
      const hiddenPx = screenHeight - rect.bottom; // band covered at the bottom
      const shown = hiddenPx > screenHeight * 0.15; // >15% ≈ keyboard, not a nav/status bar
      if (shown === lastShown) return;
      lastShown = shown;
      if (shown) bridge.emit('keyboard.show', { height: Math.round(hiddenPx / density) });
      else bridge.emit('keyboard.hide');
    },
  });
  rootView.getViewTreeObserver().addOnGlobalLayoutListener(listener);
}

function hideAndroidKeyboard(): void {
  const activity = androidActivity();
  if (!activity) return;
  const imm = activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
  const view = activity.getCurrentFocus() ?? activity.getWindow().getDecorView();
  imm?.hideSoftInputFromWindow(view.getWindowToken(), 0);
}

function androidActivity(): any {
  return Application.android.foregroundActivity ?? Application.android.startActivity;
}
