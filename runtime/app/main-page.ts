import { Application, AndroidApplication, EventData, Page, isAndroid, isIOS, knownFolders, path } from '@nativescript/core';
import { bridge } from './shell/bridge';
import { registerHandlers } from './shell/handlers';
import { registerExtendedHandlers } from './shell/handlers-extended';
import { registerParityHandlers } from './shell/handlers-parity';
import { registerSystemHandlers } from './shell/handlers-system';
import { registerBillingHandlers } from './shell/handlers-billing';
import { registerMediaHandlers } from './shell/handlers-media';
import { registerPushHandlers } from './shell/handlers-push';
import { registerAndroidHandlers } from './shell/handlers-android';
import { registerOptionalHandlers } from './shell/optional-handlers.generated';
import './shell/fcm-bootstrap.generated'; // side-effect: registers the FCM service when push is wired
import { startEventForwarding } from './shell/events';
import { SHELL_CONFIG } from './shell/config';
import { bindStatusBarPage, setStatusBarStyle, enableAndroidEdgeToEdge, wireAndroidSafeArea } from './shell/status-bar';
import { CustomWebView } from './shell/custom-webview';

let initialized = false;

export function onPageLoaded(args: EventData): void {
  const page = args.object as Page;
  page.bindingContext = { backgroundColor: SHELL_CONFIG.backgroundColor };
  bindStatusBarPage(page);
  if (isAndroid) enableAndroidEdgeToEdge();
  setStatusBarStyle(SHELL_CONFIG.statusBarStyle);

  if (initialized) return;
  initialized = true;

  // Debug mode: keep the screen awake (no auto-lock while foreground) so the dev/inspect session
  // and the iterate loop stay alive. iOS via the idle timer; Android via WebView keepScreenOn.
  if (isIOS && SHELL_CONFIG.debug) {
    try { UIApplication.sharedApplication.idleTimerDisabled = true; } catch (e) { /* no-op */ }
  }

  registerHandlers();
  registerExtendedHandlers();
  registerParityHandlers();
  registerSystemHandlers();
  registerBillingHandlers();
  registerMediaHandlers();
  registerPushHandlers();
  // Last on purpose: overrides the iOS-only placeholders with Android impls
  if (isAndroid) registerAndroidHandlers();
  // Opt-in modules that own their own handler file (health, …) — generated to only the active set.
  registerOptionalHandlers();

  const webView = page.getViewById<CustomWebView>('webview');
  bridge.attach(webView);
  if (isAndroid) wireAndroidSafeArea(webView); // experimental edge-to-edge (no-op unless config on)
  startEventForwarding();
  loadBundle(webView);

  // Halt the WebView render + JS-timer pipeline while backgrounded so a page running a continuous
  // animation (Android doesn't auto-pause rAF off-screen) stops burning CPU/battery. No-op on iOS.
  Application.on(Application.suspendEvent, () => webView.setRenderingActive(false));
  Application.on(Application.resumeEvent, () => webView.setRenderingActive(true));

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
        // Live URL (dev HMR / deployed). Bridge (WKUserScript + message handler) still injects.
        const url = NSURL.URLWithString(SHELL_CONFIG.serverUrl);
        wk.loadRequest(NSURLRequest.requestWithURL(url));
      } else if (SHELL_CONFIG.loader === 'file') {
        const entryURL = NSURL.fileURLWithPath(entryPath);
        const readAccessURL = NSURL.fileURLWithPathIsDirectory(wwwPath, true);
        wk.loadFileURLAllowingReadAccessToURL(entryURL, readAccessURL);
      } else {
        const url = NSURL.URLWithString(`app://local/${SHELL_CONFIG.entry}`);
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
        ? SHELL_CONFIG.serverUrl
        : SHELL_CONFIG.loader === 'file'
          ? `file://${entryPath}`
          : `https://appwrap.local/${SHELL_CONFIG.entry}`;
    };
    tryLoad();
  }
}
