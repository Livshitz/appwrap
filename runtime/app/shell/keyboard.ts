import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';
import { appwrapNativeLog } from './native-log';

declare const android: any;
// iOS keyboard-notification globals (marshalled from UIKit at runtime).
declare const NSNotificationCenter: any;
declare const UIKeyboardWillShowNotification: string;
declare const UIKeyboardDidShowNotification: string;
declare const UIKeyboardWillHideNotification: string;
declare const UIKeyboardDidHideNotification: string;
declare const UIKeyboardWillChangeFrameNotification: string;
declare const UIKeyboardDidChangeFrameNotification: string;
declare const UIKeyboardFrameEndUserInfoKey: string;
declare const UIKeyboardAnimationDurationUserInfoKey: string;
declare const UIEdgeInsetsZero: any;
declare const NSObject: any;
declare const UIScrollViewDelegate: any;
declare function CGPointMake(x: number, y: number): any;
declare const UIColor: any;

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

/**
 * iOS: native keyboard avoidance — a faithful port of Capacitor's `resize: native` mode
 * (capacitor-keyboard Keyboard.m), which is the battle-tested way to do this in a WKWebView shell:
 *
 *  1. DETACH the WKWebView from UIKit keyboard notifications. WKWebView internally observes them
 *     and applies its own scrollView insets/auto-scroll; with two keyboard-handling authorities the
 *     layouts stack and fling content. Capacitor removes the webview as an observer so the shell is
 *     the ONLY authority.
 *  2. RESIZE the webview frame to (window height − keyboard height) AFTER the keyboard animation
 *     finishes (animationDuration + 0.2s, debounced) — never mid-animation. Restore on hide with a
 *     near-zero delay. `marginBottom` is kept in sync so NativeScript layout passes agree with the
 *     frame instead of clobbering it.
 *  3. ZERO the scrollView contentInset on every keyboard event — WebKit's leftover keyboard inset
 *     is what double-compensates and leaves black bands.
 *
 * Also emits keyboard.show {height} / keyboard.hide to the page (heights in points ≈ CSS px).
 */
function armIosKeyboardObservers(): void {
  const center = NSNotificationCenter.defaultCenter;
  let paddingBottom = 0;
  let pendingUpdate: any = null;
  let webkitDetached = false;
  // Extra lift applied by the CURRENT show, decided by whether the ▲▼✓ accessory bar is drawn:
  // a COLD focus (fires UIKeyboardWillShow) draws the bar → reported height is accurate → 0 extra;
  // a WARM re-focus (arrives as didShow-only, no willShow) drops the bar but still reports the taller
  // height → apply the configured extra lift to close the gap. Reset when the keyboard fully hides.
  let sawWillShow = false;
  let activeExtraLift = 0;

  const getWk = (): WKWebView | undefined => bridge.getWebView()?.ios as WKWebView | undefined;

  // (1) Make the shell the only keyboard-handling authority (Capacitor does exactly this in load()).
  const detachWebKitKeyboardHandling = (): void => {
    if (webkitDetached) return;
    const wk = getWk();
    if (!wk) return;
    for (const name of [
      UIKeyboardWillShowNotification,
      UIKeyboardWillHideNotification,
      UIKeyboardWillChangeFrameNotification,
      UIKeyboardDidChangeFrameNotification,
    ]) {
      center.removeObserverNameObject(wk, name, null);
    }
    webkitDetached = true;
    if (SHELL_CONFIG.debug) appwrapNativeLog('[native:keyboard] detached WKWebView keyboard observers');
  };

  // (3) Kill WebKit's keyboard contentInset so it can't double-compensate our resize.
  const resetScrollView = (): void => {
    const wk = getWk();
    if (wk) wk.scrollView.contentInset = UIEdgeInsetsZero;
  };

  // (2) The Capacitor _updateFrame: webview frame = window bounds minus the keyboard band.
  // Never skippable: if the webview is momentarily detached from the window (page navigation,
  // instance switch — which is also when the keyboard dismisses), RETRY until it reattaches.
  // A bailed restore that's assumed applied leaves the frame shrunk forever (black band).
  const updateFrame = (attempt = 0): void => {
    const wv = bridge.getWebView();
    const wk = getWk();
    const win = wk?.window;
    if (!wv || !wk || !win) {
      if (attempt < 20) pendingUpdate = setTimeout(() => Utils.dispatchToMainThread(() => updateFrame(attempt + 1)), 100);
      else if (SHELL_CONFIG.debug) appwrapNativeLog(`[native:keyboard] frame update gave up (webview detached), pad=${paddingBottom}`);
      return;
    }
    // SINGLE layout authority: NativeScript. Only the margin changes — never wk.frame directly.
    // A manual frame write disagrees with NS layout (safe-area math) and the two ping-pong,
    // which is what produced gaps, content under the status bar, and residual scroll state.
    // Subtract the bottom safe-area inset: NS layout already excludes it, and the keyboard COVERS
    // it — margining the full keyboard height double-counts those 34pt as a gap above the keyboard.
    const safeBottom = win.safeAreaInsets?.bottom ?? 0;
    // On a WARM re-focus iOS 26 reports a keyboard TALLER than it draws (it reserves the ▲▼✓ accessory
    // row but doesn't draw it), leaving bare black native space between the shrunk webview and the
    // real keys. `activeExtraLift` (see onShow) is the configured extra lift on those warm shows and 0
    // on cold shows where the bar IS drawn — so the webview covers the strip only when it's needed.
    wv.marginBottom = paddingBottom > 0 ? Math.max(0, paddingBottom - safeBottom - activeExtraLift) : 0;
    // Property change alone doesn't reliably trigger a layout pass outside NS's own flow
    // (restore path: margin=0 was set but the view stayed shrunk until the next layout).
    wv.requestLayout();
    resetScrollView();
    // The page scrolls in inner containers; the outer scrollView must stay at origin. Clears
    // WebKit's focus auto-scroll leftovers and the "whole app scrollable" residue after hide.
    wk.scrollView.setContentOffsetAnimated(CGPointMake(0, 0), false);
    if (SHELL_CONFIG.debug) appwrapNativeLog(`[native:keyboard] marginBottom=${wv.marginBottom} (kb=${paddingBottom}, extraLift=${activeExtraLift}, ${sawWillShow ? 'cold' : 'warm'})`);
  };

  // No same-value skip: re-applying an identical frame is free, and unconditional application
  // makes every keyboard event self-healing after a missed/bailed update.
  const setKeyboardHeight = (height: number, delayMs: number): void => {
    paddingBottom = height;
    if (pendingUpdate) clearTimeout(pendingUpdate); // debounce like cancelPreviousPerformRequests
    pendingUpdate = setTimeout(() => Utils.dispatchToMainThread(() => updateFrame()), delayMs);
  };

  // Re-focus does NOT re-fire willShow — capture-verified: a second tap arrives ONLY as
  // didShow/willChangeFrame. All three feed the same idempotent handler; whichever iOS sends, the
  // shrink lands. Height-0 frame events do nothing (hide is owned by the willHide/didHide pair).
  const onShow = (tag: string, settleMs: number | null) => (note: any): void => {
    detachWebKitKeyboardHandling();
    if (tag === 'willShow') sawWillShow = true; // cold acquire → the accessory bar will be drawn
    // Warm re-focus (didShow/willChangeFrame with no willShow this cycle) → bar dropped → lift extra.
    activeExtraLift = sawWillShow ? 0 : (SHELL_CONFIG.iosKeyboardExtraLift ?? 82);
    const value = note?.userInfo?.objectForKey?.(UIKeyboardFrameEndUserInfoKey);
    // Overlap with the window, NOT frame.size.height: iOS delivers keyboard-sized but off-screen
    // end-frames during dismissal — size.height would shrink a keyboard-less screen.
    let height = 0;
    let winH = 0;
    if (value) {
      const end = value.CGRectValue;
      const win = getWk()?.window;
      winH = win ? win.bounds.size.height : 0;
      height = winH ? Math.max(0, Math.round(winH - end.origin.y)) : Math.round(end.size.height);
    }
    if (SHELL_CONFIG.debug) appwrapNativeLog(`[native:keyboard] ${tag} height=${height}`);
    resetScrollView();
    if (height <= 0) return;
    // Guard against bogus full-screen keyboard frames. iOS occasionally delivers a transitional frame
    // with origin.y≈0 (seen during SMS-OTP autofill) → height ≈ the whole window → the resize would
    // shrink the webview to a sliver (huge black gap). A real software keyboard is never >85% of the
    // screen; ignore the event and wait for the real frame (which follows and self-heals).
    if (winH && height > winH * 0.85) {
      if (SHELL_CONFIG.debug) appwrapNativeLog(`[native:keyboard] ignore bogus height=${height} (win=${Math.round(winH)})`);
      return;
    }
    // Paint the webview/window backdrop the page color so the resize shows no white flash. (The
    // iOS-26 phantom keyboard-height gap is closed geometrically by the extra lift in updateFrame.)
    syncBackdropColor();
    const duration = note?.userInfo?.objectForKey?.(UIKeyboardAnimationDurationUserInfoKey)?.doubleValue ?? 0.25;
    // willShow/willChangeFrame: resize after the animation settles. didShow: already settled.
    setKeyboardHeight(height, settleMs ?? (duration + 0.2) * 1000);
    bridge.emit('keyboard.show', { height });
  };
  center.addObserverForNameObjectQueueUsingBlock(UIKeyboardWillShowNotification, null, null, onShow('willShow', null));
  center.addObserverForNameObjectQueueUsingBlock(UIKeyboardWillChangeFrameNotification, null, null, onShow('willChangeFrame', null));
  center.addObserverForNameObjectQueueUsingBlock(UIKeyboardDidShowNotification, null, null, onShow('didShow', 50));
  center.addObserverForNameObjectQueueUsingBlock(UIKeyboardWillHideNotification, null, null, () => {
    if (SHELL_CONFIG.debug) appwrapNativeLog('[native:keyboard] willHide → restore');
    setKeyboardHeight(0, 10);
    resetScrollView();
    bridge.emit('keyboard.hide');
  });
  center.addObserverForNameObjectQueueUsingBlock(UIKeyboardDidHideNotification, null, null, () => {
    setKeyboardHeight(0, 10); // enforcement pass — a hidden keyboard must always end at full height
    resetScrollView();
    sawWillShow = false; // keyboard fully gone → next show re-decides cold (bar) vs warm (no bar)
  });

  armScrollClamp();
}

/**
 * Sample the page's background color once per keyboard-show and paint the webview + its window with
 * it (Capacitor's autoBackdropColor) so there are no white flashes during the resize.
 */
function syncBackdropColor(): void {
  try {
    const wk = bridge.getWebView()?.ios as WKWebView | undefined;
    if (!wk) return;
    wk.evaluateJavaScriptCompletionHandler('window.getComputedStyle(document.body).backgroundColor', (result: any) => {
      const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(result ?? ''));
      if (!m) return;
      Utils.dispatchToMainThread(() => {
        const w = bridge.getWebView()?.ios as WKWebView | undefined;
        if (!w) return;
        const color = UIColor.colorWithRedGreenBlueAlpha(+m[1] / 255, +m[2] / 255, +m[3] / 255, 1);
        w.backgroundColor = color;
        if (w.window) w.window.backgroundColor = color;
        if (SHELL_CONFIG.debug) appwrapNativeLog(`[native:keyboard] backdrop ← rgb(${m[1]},${m[2]},${m[3]})`);
      });
    });
  } catch (e) {
    if (SHELL_CONFIG.debug) appwrapNativeLog(`[native:keyboard] backdrop sync failed: ${e}`);
  }
}

let clampDelegate: any; // retained — a bare local would be GC'd and the native delegate dies with it

/**
 * Continuous outer-scroll clamp. WebKit's keyboard machinery scrolls the WKWebView's outer
 * scrollView at arbitrary times (focus auto-scroll while the keyboard is up, late "restore scroll"
 * compensation ~1s after hide — probe-verified offset=386 with content == bounds). Timed pins lose
 * that race by definition; a scrollViewDidScroll delegate wins every time: on EVERY scroll event
 * clamp the offset to the legitimate range. Pages that fit the viewport (app shells — inner divs
 * scroll, not the page) have exactly one legal offset: 0. Genuinely scrollable pages keep normal
 * in-range scrolling untouched.
 */
function armScrollClamp(): void {
  const attach = (attempt = 0): void => {
    const wk = bridge.getWebView()?.ios as WKWebView | undefined;
    if (!wk) {
      if (attempt < 50) setTimeout(() => attach(attempt + 1), 200);
      return;
    }
    const Delegate = (NSObject as any).extend(
      {
        scrollViewDidScroll(sv: any): void {
          const maxY = Math.max(0, sv.contentSize.height - sv.bounds.size.height + sv.contentInset.bottom);
          const y = sv.contentOffset.y;
          const clamped = Math.min(Math.max(y, 0), maxY);
          if (Math.abs(clamped - y) > 0.5) sv.setContentOffsetAnimated(CGPointMake(sv.contentOffset.x, clamped), false);
        },
      },
      { protocols: [UIScrollViewDelegate] },
    );
    clampDelegate = Delegate.new();
    wk.scrollView.delegate = clampDelegate;
    if (SHELL_CONFIG.debug) appwrapNativeLog('[native:keyboard] scroll clamp armed');
  };
  attach();
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
