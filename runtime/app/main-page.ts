import { Application, AndroidApplication, Button, EventData, LoadEventData, Page, StackLayout, WebView, isAndroid, isIOS, knownFolders, path } from '@nativescript/core';
import { bridge } from './shell/bridge';
import { effectiveServerUrl } from './shell/server-url';
import { registerHandlers } from './shell/handlers';
import { registerExtendedHandlers } from './shell/handlers-extended';
import { registerParityHandlers } from './shell/handlers-parity';
import { registerSystemHandlers } from './shell/handlers-system';
import { registerMediaHandlers } from './shell/handlers-media';
import { registerKeyboardHandlers } from './shell/keyboard';
import { registerFsHandlers } from './shell/handlers-fs';
import { registerPushHandlers } from './shell/handlers-push';
import { registerAndroidHandlers } from './shell/handlers-android';
import { registerOptionalHandlers } from './shell/optional-handlers.generated';
import { registerPlugins } from './shell/plugins.generated';
import './shell/fcm-bootstrap.generated'; // side-effect: registers the FCM service when push is wired
import { startEventForwarding } from './shell/events';
import { startDevMenu } from './shell/devmenu';
import { showEnvBannerIfActive } from './shell/env-banner';
import { reassertEnvKeepAwake } from './shell/env-keepawake';
import { SHELL_CONFIG } from './shell/config';
import { bindStatusBarPage, setStatusBarStyle, applyThemeColor, enableAndroidEdgeToEdge, wireAndroidSafeArea } from './shell/status-bar';
import { CustomWebView } from './shell/custom-webview';
import { appwrapNativeLog } from './shell/native-log';

let initialized = false;

/** DEBUG iOS lifecycle tracer — logs NS suspend/resume/displayed AND the raw UIApplication
 * activation notifications (willResignActive/didBecomeActive/didEnterBackground/willEnterForeground)
 * with each connected scene's activationState, to Documents/appwrap-web.log. Diagnostic for the
 * StoreKit-sheet freeze: a system sheet that only resigns-active (never backgrounds) produces a
 * different event sequence than a real background, so the resume/wake path may not fire on dismiss. */
let _lifecycleTraced = false;
function traceIosLifecycle(): void {
  if (_lifecycleTraced) return;
  _lifecycleTraced = true;
  const log = (e: string): void => {
    let states = '';
    try {
      const scenes = UIApplication.sharedApplication.connectedScenes.allObjects;
      for (let i = 0; i < scenes.count; i++) {
        const s = scenes.objectAtIndex(i) as UIScene;
        states += ` [${(s as any).session?.role ?? '?'}:act=${s.activationState}]`;
      }
    } catch { states = ' (scene-read-err)'; }
    appwrapNativeLog(`[native:lifecycle] ${e}${states}`);
  };
  Application.on(Application.suspendEvent, () => log('NS.suspend'));
  Application.on(Application.resumeEvent, () => log('NS.resume'));
  Application.on(Application.displayedEvent, () => log('NS.displayed'));
  const nc = NSNotificationCenter.defaultCenter;
  const obs = (name: string, tag: string): void => {
    nc.addObserverForNameObjectQueueUsingBlock(name, null, null, () => log(tag));
  };
  obs(UIApplicationWillResignActiveNotification, 'UIApp.willResignActive');
  obs(UIApplicationDidBecomeActiveNotification, 'UIApp.didBecomeActive');
  obs(UIApplicationDidEnterBackgroundNotification, 'UIApp.didEnterBackground');
  obs(UIApplicationWillEnterForegroundNotification, 'UIApp.willEnterForeground');
  appwrapNativeLog('[native:lifecycle] tracer armed');
}

/** iOS-only GLOBAL native-surface freeze recovery. Registers ONE observer on
 * UIWindowDidBecomeHiddenNotification: whenever ANY window becomes hidden — which happens when ANY
 * native modal/drawer/sheet dismisses (StoreKit manage-subscriptions sheet, OAuth session, share,
 * pickers, Safari, alerts) — we run CustomWebView.recoverAfterNativeSurface(). That covers the
 * pathological case where a same-scene system sheet dismisses with ZERO app-lifecycle events (no
 * resumeEvent, no background) yet orphans an interactive UITrackingElementWindow above ours that
 * swallows touches → WebView alive but frozen.
 *
 * WHY this generalizes the per-handler wiring: future native surfaces need NO per-handler call —
 * the dismiss inherently hides a window, so this fires. The 5 existing per-handler calls remain
 * (proven baseline); they become redundant once this observer is DEVICE-VERIFIED to fire on the
 * StoreKit-sheet dismiss and catch the orphan at ~350ms.
 *
 * SAFE/CONSERVATIVE: recoverAfterNativeSurface is additive + idempotent (no stray window ⇒ no-op),
 * COALESCES a notification burst (several windows hide per dismiss) into ONE pass, and only acts on a
 * window's HIDE (dismiss), never on a window appearing — so legitimate window stacking is untouched. */
let _surfaceRecoveryArmed = false;
function armNativeSurfaceRecovery(webView: CustomWebView): void {
  if (_surfaceRecoveryArmed) return;
  _surfaceRecoveryArmed = true;
  NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
    UIWindowDidBecomeHiddenNotification, null, null, () => webView.recoverAfterNativeSurface()
  );
  if (SHELL_CONFIG.debug) appwrapNativeLog('[native:recover] global UIWindowDidBecomeHidden observer armed');
}

export function onPageLoaded(args: EventData): void {
  const page = args.object as Page;
  page.bindingContext = { backgroundColor: SHELL_CONFIG.backgroundColor, appName: SHELL_CONFIG.name };
  bindStatusBarPage(page);
  if (isAndroid) enableAndroidEdgeToEdge();
  applyThemeColor(SHELL_CONFIG.themeColor); // manifest/config theme_color → native chrome at boot
  setStatusBarStyle(SHELL_CONFIG.statusBarStyle);

  if (initialized) return;
  initialized = true;

  registerHandlers();
  registerExtendedHandlers();
  registerParityHandlers();
  registerSystemHandlers();
  registerMediaHandlers();
  registerKeyboardHandlers();
  registerFsHandlers();
  registerPushHandlers();
  // Last on purpose: overrides the iOS-only placeholders with Android impls
  if (isAndroid) registerAndroidHandlers();
  // Opt-in modules that own their own handler file (health, …) — generated to only the active set.
  registerOptionalHandlers();
  // Config-gated TS plugins (appwrap.config `plugins`) — registers each plugin's bridge handlers.
  // No-op default when no plugins are configured (generated barrel is empty → no plugin glue compiled).
  registerPlugins();
  // Shake-to-open developer menu (App Info / Reload). On by default, incl. prod.
  if (SHELL_CONFIG.devMenu) startDevMenu();

  const webView = page.getViewById<CustomWebView>('webview');
  bridge.attach(webView);
  // NOTE: the GLOBAL UIWindowDidBecomeHidden freeze-recovery observer is intentionally NOT armed.
  // It over-fired: the iOS edit menu / text-selection callout / AutoFill bar present in their own
  // floating UIWindows, and their normal appear/disappear churn hides a transient window → the observer
  // ran neutralizeStrayWindows() and DETACHED the just-shown edit-menu window (a plain UIWindow, so no
  // class filter can distinguish it from a real orphan) → Copy/Paste + AutoFill silently dead on EVERY
  // text field (device-verified via the [native:recover] log). Freeze recovery still runs via the
  // explicit per-surface dismiss callbacks (billing/oauth/share/PHPicker/SafariVC → recoverAfterNativeSurface),
  // which are the proven baseline and only fire for actual native surfaces. Re-add a scoped observer only
  // if a future surface orphans a window with no dismiss callback — gate it on a "surface presented" flag.
  void armNativeSurfaceRecovery; // referenced to keep the helper (still callable if a scoped need arises)
  if (isAndroid) wireAndroidSafeArea(webView); // experimental edge-to-edge (no-op unless config on)
  wireLoadFallback(page, webView); // loader:'server' failure → branded retry view (no white screen)
  startEventForwarding();
  loadBundle(webView);
  // Env indicator banner: shown in the bottom safe area on relaunch when a non-default env override is
  // active (env-switcher only). Bottom-safe-area, auto-shrinks to a pill after 3s. No-op otherwise.
  showEnvBannerIfActive();
  // Keep the screen awake while pointed at a NON-DEFAULT backend (or in a debug build) — same signal as the
  // banner above, so "banner showing" ⟺ "no auto-lock". Subsumes the old iOS-only debug idle-timer block.
  reassertEnvKeepAwake();

  // Halt the WebView render + JS-timer pipeline while backgrounded so a page running a continuous
  // animation (Android doesn't auto-pause rAF off-screen) stops burning CPU/battery. No-op on iOS.
  Application.on(Application.suspendEvent, () => webView.setRenderingActive(false));
  Application.on(Application.resumeEvent, () => {
    webView.setRenderingActive(true);
    // iOS: wake the WebContent renderer NOW (it stays THROTTLED for ~30-45s after a full-window system
    // surface — StoreKit manage-subscriptions sheet, itms-apps deep link, backgrounding — froze it).
    webView.wakeWebContent();
    // Neither platform guarantees the wake lock survives a background trip (Android drops the window flag
    // outright if the Activity was recreated). Assert-only: never write `false`, so an app driving the
    // public `ui.keepAwake` bridge API itself (e.g. during video) isn't clobbered on resume.
    reassertEnvKeepAwake();
  });

  // DEBUG: trace the iOS app-lifecycle event sequence to the pullable log sink so we can see WHICH
  // resume signal does (or doesn't) fire when returning from the StoreKit sheet vs a normal background.
  if (isIOS && SHELL_CONFIG.debug) traceIosLifecycle();

  // Android system back → WebView history (iOS gets this via the edge-swipe
  // gesture). Only swallow the press when there's history to pop; otherwise let
  // the OS default through so the app can still be backgrounded/exited.
  if (isAndroid) {
    Application.android.on(AndroidApplication.activityBackPressedEvent, (data: any) => {
      const wk = webView.android as android.webkit.WebView;
      if (wk?.canGoBack()) {
        data.cancel = true;
        wk.goBack();
      }
    });
  }
}

/**
 * loader:'server' load-failure fallback (App Review 2.1a). A server-loader shell has NO local UI —
 * if the serverUrl is unreachable (offline, server down, DNS) the reviewer sees a bare white screen.
 * NS core forwards BOTH webView:didFailNavigation: and didFailProvisionalNavigation: (iOS) and the
 * main-frame onReceivedError (Android) into `loadFinishedEvent` with `args.error` — so one listener
 * covers initial-load and in-app navigation failures on both platforms. On failure: show a simple
 * branded "can't connect — retry" view + auto-retry with capped backoff; any successful load hides
 * it and resets. iOS NSURLErrorCancelled ("cancelled", a superseded navigation) is NOT a failure.
 * NOTE: web-process termination has no NS seam in a prod build (the didTerminate forwarder lives on
 * the debug-only DevCertNavDelegate) — out of scope here.
 */
function wireLoadFallback(page: Page, webView: CustomWebView): void {
  if (SHELL_CONFIG.loader !== 'server') return; // bundled loaders can't fail on network
  const fallback = page.getViewById<StackLayout>('loadFallback');
  const retryBtn = page.getViewById<Button>('loadRetryBtn');
  if (!fallback || !retryBtn) return;

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 3000;
  const clearTimer = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };
  const retry = () => {
    clearTimer();
    appwrapNativeLog('[native:fallback] retrying server load');
    // Android: loadBundle sets `src`, but re-setting the SAME value is a NS property no-op — drive
    // the native reload directly. iOS's loadBundle path issues a fresh loadRequest, so reuse it.
    const droid = isAndroid ? (webView.android as android.webkit.WebView | null) : null;
    if (droid) droid.loadUrl(effectiveServerUrl());
    else loadBundle(webView);
  };

  webView.on(WebView.loadFinishedEvent, (args: LoadEventData) => {
    const err = String(args.error ?? '');
    if (!err) {
      // successful load → hide + reset (idempotent; covers the auto-retry that finally lands)
      clearTimer();
      backoffMs = 3000;
      if (fallback.visibility !== 'collapse') {
        appwrapNativeLog('[native:fallback] load recovered — hiding fallback');
        fallback.visibility = 'collapse';
      }
      return;
    }
    if (/cancel/i.test(err)) return; // NSURLErrorCancelled: navigation superseded, not a failure
    appwrapNativeLog(`[native:fallback] load failed: ${err}`);
    fallback.visibility = 'visible';
    if (!retryTimer) {
      retryTimer = setTimeout(() => { backoffMs = Math.min(backoffMs * 2, 30_000); retry(); }, backoffMs);
    }
  });
  retryBtn.on(Button.tapEvent, retry);
}

function loadBundle(webView: CustomWebView): void {
  const wwwPath = path.join(knownFolders.currentApp().path, 'www');
  const entryPath = path.join(wwwPath, SHELL_CONFIG.entry);

  if (isIOS) {
    // Wait for the native WKWebView to exist, then load. Default: app:// custom
    // scheme (stable origin, ES modules work). 'file' loader kept for debugging.
    const tryLoad = () => {
      const wk = webView.ios as WKWebView;
      if (!wk) {
        setTimeout(tryLoad, 50);
        return;
      }
      if (SHELL_CONFIG.loader === 'server' && SHELL_CONFIG.serverUrl) {
        // Live URL (dev HMR / deployed), or a persisted debug override. Bridge still injects.
        const url = NSURL.URLWithString(effectiveServerUrl());
        wk.loadRequest(NSURLRequest.requestWithURL(url));
      } else if (SHELL_CONFIG.loader === 'file') {
        const entryURL = NSURL.fileURLWithPath(entryPath);
        const readAccessURL = NSURL.fileURLWithPathIsDirectory(wwwPath, true);
        wk.loadFileURLAllowingReadAccessToURL(entryURL, readAccessURL);
      } else {
        const url = NSURL.URLWithString(`app://localhost/${SHELL_CONFIG.entry}`);
        wk.loadRequest(NSURLRequest.requestWithURL(url));
      }
    };
    tryLoad();
  } else if (isAndroid) {
    // Settings, transport (onJsPrompt) and the appwrap.local asset interceptor
    // are wired in CustomWebView.initNativeView (custom-webview.android.ts).
    const tryLoad = () => {
      if (!webView.android) {
        setTimeout(tryLoad, 50);
        return;
      }
      webView.src = SHELL_CONFIG.loader === 'server' && SHELL_CONFIG.serverUrl
        ? effectiveServerUrl()
        : SHELL_CONFIG.loader === 'file'
          ? `file://${entryPath}`
          : `https://appwrap.local/${SHELL_CONFIG.entry}`;
    };
    tryLoad();
  }
}
