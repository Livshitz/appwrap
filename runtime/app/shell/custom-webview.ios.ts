import { WebView, knownFolders, path as nsPath, File } from '@nativescript/core';
import { SHELL_CONFIG } from './config';
import { mimeFor } from './mime';
import { APPWRAP_GLOBALS_JS, NATIVE_FEEL_JS, capabilityGuardJs, serviceWorkerGuardJs, externalNavGuardJs } from './web-quirks';
import { envGlobalsJs } from './env';
import { createUiDelegate } from './ios-ui-delegate';
import { appwrapNativeLog } from './native-log';

/**
 * iOS CustomWebView — configures WKWebView before creation (inline media,
 * persistent data store), registers a real WKScriptMessageHandler named
 * `appwrap` (page → `webkit.messageHandlers.appwrap.postMessage(json)`), and
 * serves the bundled PWA via a custom `app://` WKURLSchemeHandler so
 * unmodified ES-module PWAs load with a stable origin (file:// blocks module
 * scripts — origin "null" CORS).
 */
// Forwarded WebView console/errors → the shared native-log sink (Documents/appwrap-web.log).
const appendWebLog = appwrapNativeLog;

/** Parse a #rrggbb config color into a UIColor (for the WebView background). */
function uiColorFromHex(hex?: string): UIColor | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return UIColor.colorWithRedGreenBlueAlpha(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1);
}

/** WKScriptMessageHandler for the `appwrap` channel — forwards JSON envelopes to the owning view. */
@NativeClass()
class AppwrapScriptHandler extends NSObject implements WKScriptMessageHandler {
  static ObjCProtocols = [WKScriptMessageHandler];
  owner!: WeakRef<CustomWebView>;
  static new(): AppwrapScriptHandler {
    return <AppwrapScriptHandler>super.new();
  }
  userContentControllerDidReceiveScriptMessage(_controller: WKUserContentController, message: WKScriptMessage): void {
    const view = this.owner.get ? this.owner.get() : (this.owner as { deref(): CustomWebView }).deref();
    const body = message.body;
    // Envelopes always travel as JSON strings (protocol v1)
    if (view?.onAppwrapMessage && typeof body === 'string') {
      view.onAppwrapMessage(body);
    } else {
      // Nothing to dispatch to (bridge detached / view gone) or a non-string body ⇒ this request is
      // DROPPED and can never be answered — the caller's watchdog will report a false TIMEOUT for it.
      // We cannot respond (there is no bridge here), so at least never drop it in silence.
      appendWebLog('[native] appwrap request DROPPED (no bridge attached) — caller will see a false TIMEOUT');
      console.error('AppWrap: request dropped — no bridge attached; caller will report a false TIMEOUT');
    }
  }
}

/** WKScriptMessageHandler for the `appwrapLog` channel — debug console-forwarding to the file sink. */
@NativeClass()
class AppwrapLogHandler extends NSObject implements WKScriptMessageHandler {
  static ObjCProtocols = [WKScriptMessageHandler];
  static new(): AppwrapLogHandler {
    return <AppwrapLogHandler>super.new();
  }
  userContentControllerDidReceiveScriptMessage(_c: WKUserContentController, message: WKScriptMessage): void {
    // Write to the file sink — NS console.log / NSLog don't surface to devicectl/idevicesyslog
    // on a device build, but a file in the app container is reliably pullable.
    if (typeof message.body === 'string') appendWebLog(message.body);
  }
}

/** Host[:port] of a URL, lowercased; '' if unparseable (scheme/path/userinfo stripped). */
function hostOfUrl(url: string): string {
  const afterScheme = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0];
  return (authority.split('@').pop() || authority).toLowerCase();
}

/**
 * DEBUG-ONLY dev-server cert trust. A `WKNavigationDelegate` that accepts the server-trust challenge for
 * the ONE build-time host (`SHELL_CONFIG.serverUrl`, NOT the switchable override) and ONLY in a debug build — so `appwrap dev`
 * against a local vite HTTPS server with a self-signed cert loads on-device with NO per-device CA install
 * (and getUserMedia/mic works — a secure context). NEVER in a store build (gated on `SHELL_CONFIG.debug`,
 * which `appwrap build` never sets), and scoped to exactly one host so it can't blanket-trust the internet.
 *
 * It WRAPS NativeScript's own navigation delegate: every other selector is forwarded to the original via
 * ObjC message forwarding (`forwardingTargetForSelector:` + a `respondsToSelector:` that also consults the
 * fallback), so NS's load-lifecycle events keep firing. This is a DISTINCT gate from the env-switcher
 * (which is allowlist+enabled-gated and runs in all builds); cert trust stays debug-only + host-scoped.
 */
@NativeClass()
class DevCertNavDelegate extends NSObject implements WKNavigationDelegate {
  static ObjCProtocols = [WKNavigationDelegate];
  fallback: WKNavigationDelegate | null = null;
  static withFallback(fb: WKNavigationDelegate | null): DevCertNavDelegate {
    const d = <DevCertNavDelegate>DevCertNavDelegate.new();
    d.fallback = fb;
    return d;
  }
  private fbResponds(sel: string): boolean {
    const f = this.fallback as any;
    return !!(f && f.respondsToSelector && f.respondsToSelector(sel));
  }

  // The reason this delegate exists: trust a self-signed cert for the build-time serverUrl host, debug
  // only. Host WITHOUT port (protectionSpace.host has no port; serverUrl may, e.g. a :3000 dev server).
  // Scoped to the BUILD-TIME host, never the switchable override (would enable MITM on a switched host).
  webViewDidReceiveAuthenticationChallengeCompletionHandler(
    webView: WKWebView,
    challenge: NSURLAuthenticationChallenge,
    completionHandler: (d: NSURLSessionAuthChallengeDisposition, c: NSURLCredential | null) => void
  ): void {
    const space = challenge.protectionSpace;
    const stripPort = (h: string) => h.replace(/:\d+$/, '');
    const allowedHost = stripPort(hostOfUrl(SHELL_CONFIG.serverUrl));
    if (
      SHELL_CONFIG.debug && !!allowedHost &&
      space.authenticationMethod === NSURLAuthenticationMethodServerTrust &&
      stripPort(hostOfUrl(space.host)) === allowedHost && space.serverTrust
    ) {
      appendWebLog(`[native:devcert] trusting self-signed cert for ${space.host} (debug + host-scoped)`);
      completionHandler(NSURLSessionAuthChallengeDisposition.UseCredential, NSURLCredential.credentialForTrust(space.serverTrust));
      return;
    }
    if (this.fbResponds('webView:didReceiveAuthenticationChallenge:completionHandler:')) {
      (this.fallback as any).webViewDidReceiveAuthenticationChallengeCompletionHandler(webView, challenge, completionHandler);
      return;
    }
    completionHandler(NSURLSessionAuthChallengeDisposition.PerformDefaultHandling, null);
  }

  // We REPLACE NS's navigationDelegate, so we MUST re-implement every method NS relied on and forward it
  // EXPLICITLY — ObjC message forwarding (forwardingTargetForSelector) is unreliable for a @NativeClass,
  // and a decision method (below) whose `decisionHandler` is never called STALLS the navigation → blank.
  webViewDecidePolicyForNavigationActionDecisionHandler(webView: WKWebView, navigationAction: any, decisionHandler: (p: number) => void): void {
    // External URL schemes (mailto:/tel:/app deeplinks/…) can't be rendered by the WKWebView —
    // navigating to one in-place silently fails ("unsupported URL"). Mirror the Android shell's
    // shouldOverrideUrlLoading: hand every non-web scheme to the OS and cancel the navigation.
    // http/https/file/about/blob/data (+ empty) stay in-WebView.
    try {
      const url: NSURL | null = navigationAction?.request?.URL ?? null;
      const scheme = url?.scheme?.toLowerCase?.() ?? '';
      // 'app' is the shell's own WKURLSchemeHandler serving the bundled PWA (loader:'app') — in-WebView.
      if (scheme && !['http', 'https', 'file', 'about', 'blob', 'data', 'javascript', 'app'].includes(scheme)) {
        UIApplication.sharedApplication.openURLOptionsCompletionHandler(url!, NSDictionary.new() as any, null);
        decisionHandler(0 /* WKNavigationActionPolicy.Cancel */);
        return;
      }
    } catch (e) {
      console.warn('AppWrap: external-scheme nav check failed', e);
    }
    if (this.fbResponds('webView:decidePolicyForNavigationAction:decisionHandler:')) {
      (this.fallback as any).webViewDecidePolicyForNavigationActionDecisionHandler(webView, navigationAction, decisionHandler);
    } else {
      decisionHandler(1 /* WKNavigationActionPolicy.Allow */);
    }
  }
  webViewDecidePolicyForNavigationResponseDecisionHandler(webView: WKWebView, navigationResponse: any, decisionHandler: (p: number) => void): void {
    if (this.fbResponds('webView:decidePolicyForNavigationResponse:decisionHandler:')) {
      (this.fallback as any).webViewDecidePolicyForNavigationResponseDecisionHandler(webView, navigationResponse, decisionHandler);
    } else {
      decisionHandler(1 /* WKNavigationResponsePolicy.Allow */);
    }
  }
  webViewDidStartProvisionalNavigation(webView: WKWebView, navigation: any): void {
    if (this.fbResponds('webView:didStartProvisionalNavigation:')) (this.fallback as any).webViewDidStartProvisionalNavigation(webView, navigation);
  }
  webViewDidCommitNavigation(webView: WKWebView, navigation: any): void {
    if (this.fbResponds('webView:didCommitNavigation:')) (this.fallback as any).webViewDidCommitNavigation(webView, navigation);
  }
  webViewDidFinishNavigation(webView: WKWebView, navigation: any): void {
    if (this.fbResponds('webView:didFinishNavigation:')) (this.fallback as any).webViewDidFinishNavigation(webView, navigation);
  }
  webViewDidFailNavigationWithError(webView: WKWebView, navigation: any, error: NSError): void {
    if (this.fbResponds('webView:didFailNavigation:withError:')) (this.fallback as any).webViewDidFailNavigationWithError(webView, navigation, error);
  }
  webViewDidFailProvisionalNavigationWithError(webView: WKWebView, navigation: any, error: NSError): void {
    if (this.fbResponds('webView:didFailProvisionalNavigation:withError:')) (this.fallback as any).webViewDidFailProvisionalNavigationWithError(webView, navigation, error);
  }
  webViewWebContentProcessDidTerminate(webView: WKWebView): void {
    if (this.fbResponds('webViewWebContentProcessDidTerminate:')) (this.fallback as any).webViewWebContentProcessDidTerminate(webView);
  }
}

export class CustomWebView extends WebView {
  constructor() {
    super();
    // The WKWebView must OWN the safe areas for CSS env(safe-area-inset-*) to be non-zero: WebKit
    // (WKWebViewIOS.mm _computedUnobscuredSafeAreaInset) feeds env() from the WKWebView's OWN UIKit
    // safeAreaInsets when contentInsetAdjustmentBehavior is .never — which requires the view's frame
    // to genuinely extend under the status bar / home indicator. NS core's WebView defaults
    // `iosOverflowSafeArea` to FALSE (only layout containers default true), which routes every layout
    // pass through IOSHelper.shrinkToSafeArea: whenever the pass runs with the view attached to a
    // window, the frame is boxed inside the safe area → safeAreaInsets become 0 → env() = 0, and the
    // wrapped page's own safe-area padding collapses (content behind the notch). Whether the shrink
    // actually lands is TIMING-dependent (NS's _cachedFrame skips re-adjustment when the frame value
    // is unchanged), so devices differ. `true` flips NS to its expandBeyondSafeArea path —
    // deterministic full-bleed frame, real safeAreaInsets, env() populated. Page-level padding then
    // works with zero per-app configuration. (iOS-only NS property; inert on Android.)
    this.iosOverflowSafeArea = true;
  }

  /** Set by the bridge before load; receives raw envelope JSON. */
  onAppwrapMessage: ((json: string) => void) | null = null;
  private _scriptHandler!: AppwrapScriptHandler; // retained — WKUserContentController holds it weakly
  private _logHandler!: AppwrapLogHandler; // retained — debug console-forwarding handler
  private _schemeHandler!: WKURLSchemeHandler;
  // NOT `_uiDelegate`: the base NativeScript WebView uses that exact field name, and
  // TS `private` is compile-time only — sharing it let super.initNativeView() overwrite
  // our media-capture delegate with NS's, so getUserMedia re-prompted every call.
  private _appwrapUiDelegate!: WKUIDelegate; // retained — WKWebView holds uiDelegate weakly
  private _navDelegate: DevCertNavDelegate | null = null; // retained — WKWebView holds navigationDelegate weakly

  /** No-op on iOS: WKWebView suspends rAF/timers itself when the app leaves the foreground.
   * Kept for parity with the Android impl (wired to suspend/resume in main-page). */
  setRenderingActive(_active: boolean): void {
    /* OS-managed on iOS */
  }

  /**
   * Proactively WAKE the WebContent renderer process on foreground (wired to Application.resumeEvent
   * for iOS in main-page). WHY: when a full-window system surface covers the app — StoreKit's
   * showManageSubscriptions(in:) (hosted out-of-process by com.apple.ios.StoreKitUIService), the
   * itms-apps subscriptions deep link, or any backgrounding — the UIScene goes non-foreground and
   * WebKit THROTTLES/SUSPENDS the WKWebView's WebContent process; its JS stops and the app UI (which
   * IS the WebView) freezes. On return, WebKit re-acquires the scene assertion lazily (~30-45s),
   * leaving the page frozen until then. An inbound `evaluateJavaScript` is a foreground WebContent
   * activity (WebPageProxy::runJavaScriptInFrameInScriptWorld) — it forces WebKit to restore the
   * process NOW instead of waiting out the throttle. The injected JS also re-fires a synthetic
   * `visibilitychange`/`pageshow` so a loader:'server' web app reconnects its sockets immediately
   * (it would otherwise wait for WebKit to deliver the native visibility event late). No-op on Android. */
  wakeWebContent(): void {
    const wk = this.nativeViewProtected as WKWebView;
    if (!wk) return;
    if (SHELL_CONFIG.debug) appendWebLog(`[native:lifecycle] wakeWebContent run (frame ${wk.frame.size.width}x${wk.frame.size.height})`);
    // (1) COMPOSITOR NUDGE — force a layout + compositing pass so a WebView that returned from an
    // occluding system surface (StoreKit sheet, deep link, backgrounding) repaints + re-hit-tests NOW
    // rather than waiting out WebKit's lazy restore. A 1px frame perturbation, restored in the same
    // runloop. (For the StoreKit-sheet freeze the primary fix is neutralising the orphaned tracking
    // window in handlers-billing/the Swift shim; this nudge + the JS wake below complete the resume the
    // OS never fires for that sheet — see handlers-billing.manageSubscriptionsSheet.)
    const f = wk.frame;
    if (f.size.width > 0 && f.size.height > 1) {
      wk.frame = CGRectMake(f.origin.x, f.origin.y, f.size.width, f.size.height - 1);
      wk.frame = f;
      wk.setNeedsLayout();
      wk.layoutIfNeeded();
    }
    // (2) Re-emit visibility so the page's own visibilitychange/pageshow listeners (socket reconnect,
    // session refresh) run right away. document.hidden is already false on foreground — this just
    // un-blocks resume handlers that gate on the event rather than polling.
    wk.evaluateJavaScriptCompletionHandler(
      `try{document.dispatchEvent(new Event('visibilitychange'));` +
      `window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));}catch(e){}`,
      () => { /* fire-and-forget; the eval itself is the wake */ }
    );
  }

  /** Coalesce flag: at most one pending recovery pass at a time (see recoverAfterNativeSurface). */
  private _recoveryPending = false;

  /** Call after dismissing ANY native surface presented over the WebView (StoreKit sheet, OAuth
   * ASWebAuthenticationSession, SFSafariViewController, pickers, share, alerts). Such surfaces can
   * leave the WebView frozen: a same-scene system sheet doesn't fire resumeEvent AND can orphan an
   * interactive window above ours that swallows touches. We neutralise any stray window FIRST (so the
   * wake re-attaches over a clean stack), then wake. Deferred so the dismissal animation finalizes the
   * orphan window first. Idempotent + safe (no stray ⇒ no-op). No-op on Android.
   *
   * COALESCED: a single dismiss fires UIWindowDidBecomeHiddenNotification multiple times and several
   * windows can hide at once (the global observer in main-page.ts), so we collapse a burst to ONE pass
   * via _recoveryPending rather than stacking dozens of 350ms timers. The per-handler callers also
   * route through this, so handler + observer firing for the same dismiss = one recovery. */
  recoverAfterNativeSurface(): void {
    if (this._recoveryPending) return;
    this._recoveryPending = true;
    setTimeout(() => {
      this._recoveryPending = false;
      try { this.neutralizeStrayWindows(); } catch (e) { /* best-effort */ }
      this.wakeWebContent();
    }, 350);
  }

  /** Remove any window sitting ABOVE our main app window (a leftover system-surface window that can
   * intercept touches): disable interaction, hide, and detach from the scene. Re-key our main window.
   * Main = lowest-level non-hidden window with a rootViewController. Logs before/after (debug). */
  private neutralizeStrayWindows(): void {
    const dbg = SHELL_CONFIG.debug;
    const scenes = UIApplication.sharedApplication.connectedScenes.allObjects;
    for (let i = 0; i < scenes.count; i++) {
      const scene = scenes.objectAtIndex(i);
      if (!scene.isKindOfClass(UIWindowScene.class())) continue;
      const ws = scene as UIWindowScene;
      const windows = ws.windows;
      let main: UIWindow | null = null;
      for (let j = 0; j < windows.count; j++) {
        const w = windows.objectAtIndex(j);
        if (w.hidden || !w.rootViewController) continue;
        if (!main || w.windowLevel < main.windowLevel) main = w;
      }
      for (let j = 0; j < windows.count; j++) {
        const w = windows.objectAtIndex(j);
        if (main && w !== main && w.windowLevel > 0 && !w.hidden) {
          if (dbg) appendWebLog(`[native:recover] stray win[${j}] ${NSStringFromClass(w.class())} lvl=${w.windowLevel} uie=${w.userInteractionEnabled} key=${w.keyWindow}`);
          w.userInteractionEnabled = false;
          w.hidden = true;
          w.windowScene = null; // detach from the scene — strongest removal
          if (dbg) appendWebLog(`[native:recover]  after set: hidden=${w.hidden} uie=${w.userInteractionEnabled} scene=${w.windowScene ? 'set' : 'nil'}`);
        }
      }
      if (main) main.makeKeyAndVisible();
      if (dbg) {
        let s = '';
        const after = ws.windows;
        for (let k = 0; k < after.count; k++) { const w = after.objectAtIndex(k); s += ` [${k}]lvl${w.windowLevel}h${w.hidden}k${w.keyWindow}`; }
        appendWebLog(`[native:recover] post mainKey=${main ? main.keyWindow : '?'} windows:${s}`);
      }
    }
  }

  createNativeView(): WKWebView {
    const config = WKWebViewConfiguration.new();
    config.allowsInlineMediaPlayback = true;
    config.allowsPictureInPictureMediaPlayback = true;
    config.mediaTypesRequiringUserActionForPlayback = 0; // WKAudiovisualMediaTypeNone
    // Element Fullscreen API (iOS 15.4+): the JS Fullscreen API on arbitrary elements is gated behind
    // this preference (native <video> fullscreen works without it). respondsToSelector-guarded so it's a
    // no-op on older iOS (mirrors the setInspectable: probe below).
    if (config.preferences.respondsToSelector('setElementFullscreenEnabled:')) {
      (config.preferences as WKPreferences & { elementFullscreenEnabled: boolean }).elementFullscreenEnabled = true;
    }
    config.websiteDataStore = WKWebsiteDataStore.defaultDataStore();
    // Apple's hard requirement for a service worker in a WKWebView: restrict navigation to the
    // declared app-bound domains (also stamped to Info.plist WKAppBoundDomains). Only set when
    // configured — otherwise the WebView stays unrestricted (default behavior).
    if (SHELL_CONFIG.appBoundDomains?.length) config.limitsNavigationsToAppBoundDomains = true;

    // Env hints + framework globals (backend origin) + the TCC capability guard for UNDECLARED web APIs
    // (reject camera/mic/geolocation in JS before WebKit's native path — see capabilityGuardJs) +
    // native-feel suppression, all injected before the page's own scripts run. Globals first so the page
    // can read __APPWRAP__ / __APPWRAP_BACKEND_ORIGIN__.
    const hasPlistKey = (k: string) => !!NSBundle.mainBundle.objectForInfoDictionaryKey(k);
    const capabilityGuard = capabilityGuardJs({
      camera: hasPlistKey('NSCameraUsageDescription'),
      microphone: hasPlistKey('NSMicrophoneUsageDescription'),
      geolocation: hasPlistKey('NSLocationWhenInUseUsageDescription'),
    });
    const swGuard = serviceWorkerGuardJs(SHELL_CONFIG.neutralizeServiceWorker);
    const extNavGuard = externalNavGuardJs(SHELL_CONFIG.openNewWindowsInBrowser);
    for (const src of [envGlobalsJs(), APPWRAP_GLOBALS_JS, capabilityGuard, swGuard, extNavGuard, NATIVE_FEEL_JS]) {
      const script = WKUserScript.alloc().initWithSourceInjectionTimeForMainFrameOnly(
        src,
        WKUserScriptInjectionTime.AtDocumentStart,
        true
      );
      config.userContentController.addUserScript(script);
    }

    const owner = new WeakRef<CustomWebView>(this);
    this._scriptHandler = AppwrapScriptHandler.new();
    this._scriptHandler.owner = owner;
    config.userContentController.addScriptMessageHandlerName(this._scriptHandler, 'appwrap');

    // Debug console-forwarding: web console/errors → NSLog (via NS console.log) → device console,
    // so `appwrap logs ios` can stream them headlessly. Only wired in debug mode.
    if (SHELL_CONFIG.debug) {
      this._logHandler = AppwrapLogHandler.new();
      config.userContentController.addScriptMessageHandlerName(this._logHandler, 'appwrapLog');
      appendWebLog('[native] log handler registered'); // boot marker: proves the file sink works
    }

    this._schemeHandler = createAppSchemeHandler();
    config.setURLSchemeHandlerForURLScheme(this._schemeHandler, 'app');

    const webView = WKWebView.alloc().initWithFrameConfiguration(CGRectZero, config);

    // Kill the remaining "web page" tells the viewport/CSS can't reach:
    // rubber-band overscroll, long-press link preview, data-detector menus,
    // and the auto content-inset (the page owns safe areas via env()).
    webView.scrollView.bounces = false;
    webView.scrollView.contentInsetAdjustmentBehavior = 2; // .never

    // No white flash before the page paints: make the WebView transparent so the (themed) NS page
    // backgroundColor shows through during load — critical for loader:'server' (network) startups.
    const bg = uiColorFromHex(SHELL_CONFIG.backgroundColor);
    webView.opaque = false;
    if (bg) { webView.backgroundColor = bg; webView.scrollView.backgroundColor = bg; }
    webView.allowsLinkPreview = false;
    // Edge-swipe to go back/forward in WebView history — the iOS native gesture
    // users expect. SPAs that own their own history still get it for free.
    webView.allowsBackForwardNavigationGestures = true;
    if (webView.configuration.dataDetectorTypes !== undefined) {
      webView.configuration.dataDetectorTypes = 0; // WKDataDetectorTypeNone (WKDataDetectorTypes.None)
    }

    // Observability (debug mode only): make the WebView debuggable via Safari Web Inspector
    // (Develop → <device> → Para) — full console + network. iOS 16.4+ (guarded). Off in store builds.
    if (SHELL_CONFIG.debug && webView.respondsToSelector('setInspectable:')) webView.inspectable = true;

    this._appwrapUiDelegate = createUiDelegate();
    webView.UIDelegate = this._appwrapUiDelegate;

    return webView;
  }

  /** Debug diagnostic: snapshot the native safe-area geometry (frame, safeAreaInsets, scroll-view
   * inset behavior, superview chain) into the page as `window.__appwrapSafeAreaDiag` + the file log.
   * Support surface for "env(safe-area-inset-*) is 0" reports — separates the UIKit side (view
   * geometry, this snapshot) from the WebKit side (viewport-fit meta, see NATIVE_FEEL_JS): the field
   * bug this was built for showed PERFECT native insets while a late page viewport meta without
   * viewport-fit reverted cover and zeroed env(). Debug builds only. */
  private snapshotSafeAreaDiag(tag: string): void {
    const wk = this.nativeViewProtected as WKWebView;
    if (!wk) return;
    const r = (x: CGRect) => `${Math.round(x.origin.x)},${Math.round(x.origin.y)},${Math.round(x.size.width)}x${Math.round(x.size.height)}`;
    const ins = (i: UIEdgeInsets) => `t${i.top} l${i.left} b${i.bottom} r${i.right}`;
    const chain: string[] = [];
    let v: UIView | null = wk;
    while (v) { chain.push(`${NSStringFromClass(v.class())}[${r(v.frame)}]sa(${ins(v.safeAreaInsets)})`); v = v.superview; }
    const win = wk.window;
    const diag = {
      tag,
      frame: r(wk.frame), bounds: r(wk.bounds),
      safeAreaInsets: ins(wk.safeAreaInsets),
      behavior: wk.scrollView.contentInsetAdjustmentBehavior,
      adjusted: ins(wk.scrollView.adjustedContentInset),
      contentInset: ins(wk.scrollView.contentInset),
      inWindow: !!win,
      windowSA: win ? ins(win.safeAreaInsets) : 'nil',
      windowFrame: win ? r(win.frame) : 'nil',
      chain: chain.join(' < '),
    };
    const js = `window.__appwrapSafeAreaDiag=${JSON.stringify(JSON.stringify(diag))};`;
    wk.evaluateJavaScriptCompletionHandler(js, () => { /* fire-and-forget */ });
    appendWebLog(`[native:sa-diag] ${JSON.stringify(diag)}`);
  }

  initNativeView(): void {
    super.initNativeView();
    // Debug builds: delayed safe-area snapshots after the view settles in-window (see method doc).
    if (SHELL_CONFIG.debug) {
      for (const ms of [1500, 4000, 8000]) setTimeout(() => this.snapshotSafeAreaDiag(`t+${ms}`), ms);
    }
    // NativeScript's WebView assigns its own wkWebView.UIDelegate during init,
    // which clobbers the media-capture grant set in createNativeView — so WebKit
    // falls back to prompting on every getUserMedia call. Reassert ours last so
    // the `.grant` sticks: iOS then prompts once (TCC), like a native app.
    const wk = this.nativeViewProtected as WKWebView;
    if (wk && this._appwrapUiDelegate) wk.UIDelegate = this._appwrapUiDelegate;
    // DEBUG-ONLY dev-server cert trust: wrap NS's navigation delegate so a self-signed local dev server
    // loads without a per-device CA install. Only in a debug server-loader build; forwards all other
    // nav-delegate selectors to NS's original so load events keep firing. Never compiled-active in a
    // store build (SHELL_CONFIG.debug is false there).
    if (wk && SHELL_CONFIG.debug && SHELL_CONFIG.loader === 'server') {
      this._navDelegate = DevCertNavDelegate.withFallback(wk.navigationDelegate);
      wk.navigationDelegate = this._navDelegate;
    }
    // Lightweight self-check surfaced via debug.webviewInfo (support diagnostics).
    (global as { __appwrapWebviewDiag?: string }).__appwrapWebviewDiag =
      `delegateIsMine=${!!wk && wk.UIDelegate === this._appwrapUiDelegate} ` +
      `respondsToMedia=${!!wk && !!wk.UIDelegate && !!wk.UIDelegate.respondsToSelector?.('webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:')}`;
  }
}

/**
 * app://local/<path> handler:
 *  - bundled file exists       → serve it (the offline www).
 *  - GET navigation, no ext    → SPA fallback to the app shell (client-side routes).
 *  - else + backendOrigin set  → PROXY to the backend via a native URLSession request, returned
 *      under the app:// URL so the WebView sees it as SAME-ORIGIN (no CORS needed — this is what
 *      makes a same-origin PWA's relative /api & /functions calls work offline). iOS gives us the
 *      request body, so POSTs proxy fine.
 *  - else                      → 404 (or SPA fallback when there's no backend).
 */
function createAppSchemeHandler(): WKURLSchemeHandler {
  const wwwPath = nsPath.join(knownFolders.currentApp().path, 'www');

  const serveFile = (task: WKURLSchemeTask, url: NSURL, filePath: string, ext: string): void => {
    const data = NSData.dataWithContentsOfFile(filePath);
    const mime = mimeFor(ext, filePath);
    const response = NSHTTPURLResponse.alloc().initWithURLStatusCodeHTTPVersionHeaderFields(
      url, 200, 'HTTP/1.1',
      // NS auto-marshals this JS object into NSDictionary<string,string>
      {
        'Content-Type': `${mime}; charset=utf-8`,
        'Content-Length': String(data?.length ?? 0),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      } as unknown as NSDictionary<string, string>
    );
    task.didReceiveResponse(response);
    if (data) task.didReceiveData(data);
    task.didFinish();
  };

  const proxyToBackend = (task: WKURLSchemeTask, url: NSURL, rel: string): void => {
    const backend = SHELL_CONFIG.backendOrigin.replace(/\/+$/, '');
    const query = url.query ? `?${url.query}` : '';
    const req = NSMutableURLRequest.requestWithURL(NSURL.URLWithString(`${backend}/${rel}${query}`));
    req.HTTPMethod = String(task.request.HTTPMethod ?? 'GET');
    const hdrs = task.request.allHTTPHeaderFields;
    if (hdrs) req.allHTTPHeaderFields = hdrs;
    req.setValueForHTTPHeaderField(null as unknown as string, 'Host'); // let URLSession set Host from the target URL
    // WKURLSchemeHandler delivers a POST/PUT body via HTTPBodyStream (not HTTPBody) — read it.
    let body: NSData = task.request.HTTPBody;
    if (!body && task.request.HTTPBodyStream) {
      const stream = task.request.HTTPBodyStream;
      const acc = NSMutableData.alloc().init();
      const cap = 16384;
      const buf = interop.alloc(cap);
      stream.open();
      while (stream.hasBytesAvailable) {
        const n = stream.readMaxLength(buf, cap);
        if (n <= 0) break;
        acc.appendBytesLength(buf, n);
      }
      stream.close();
      if (acc.length) body = acc;
    }
    if (body) req.HTTPBody = body;

    const dataTask = NSURLSession.sharedSession.dataTaskWithRequestCompletionHandler(
      req,
      (data: NSData, resp: NSURLResponse, error: NSError) => {
        try {
          if (error || !resp) {
            const r = NSHTTPURLResponse.alloc().initWithURLStatusCodeHTTPVersionHeaderFields(
              url, 502, 'HTTP/1.1', { 'Content-Length': '0' } as unknown as NSDictionary<string, string>
            );
            task.didReceiveResponse(r);
            task.didFinish();
            return;
          }
          // Re-emit under the app:// URL (same-origin). Strip Content-Encoding (URLSession already
          // decoded the body) and recompute length; keep the upstream Content-Type + status.
          // resp is NSHTTPURLResponse at runtime (HTTP request) — cast for the HTTP-only members.
          const httpResp = resp as NSHTTPURLResponse;
          const ct = httpResp.valueForHTTPHeaderField?.('Content-Type') ?? 'application/octet-stream';
          const out = NSHTTPURLResponse.alloc().initWithURLStatusCodeHTTPVersionHeaderFields(
            url, httpResp.statusCode ?? 200, 'HTTP/1.1',
            { 'Content-Type': ct, 'Content-Length': String(data?.length ?? 0), 'Cache-Control': 'no-cache' } as unknown as NSDictionary<string, string>
          );
          task.didReceiveResponse(out);
          if (data) task.didReceiveData(data);
          task.didFinish();
        } catch (e) {
          // task was stopped/cancelled mid-flight — messaging it throws; ignore.
        }
      }
    );
    dataTask.resume();
  };

  @NativeClass()
  class AppSchemeHandler extends NSObject implements WKURLSchemeHandler {
    static ObjCProtocols = [WKURLSchemeHandler];
    static new(): AppSchemeHandler {
      return <AppSchemeHandler>super.new();
    }
    webViewStartURLSchemeTask(_webView: WKWebView, task: WKURLSchemeTask): void {
      const url = task.request.URL;
      let rel = decodeURIComponent(String(url.path ?? '/')).replace(/^\/+/, '');
      if (!rel) rel = SHELL_CONFIG.entry;
      const filePath = nsPath.join(wwwPath, rel);
      const ext = rel.includes('.') ? rel.split('.').pop()!.toLowerCase() : '';

      if (File.exists(filePath)) { serveFile(task, url, filePath, ext); return; }

      const method = String(task.request.HTTPMethod ?? 'GET').toUpperCase();
      const accept = task.request.valueForHTTPHeaderField?.('Accept') ?? '';
      const isNavigation = method === 'GET' && accept.indexOf('text/html') >= 0;

      if (isNavigation && !ext) { serveFile(task, url, nsPath.join(wwwPath, SHELL_CONFIG.entry), 'html'); return; }
      if (SHELL_CONFIG.backendOrigin) { proxyToBackend(task, url, rel); return; }
      if (!ext) { serveFile(task, url, nsPath.join(wwwPath, SHELL_CONFIG.entry), 'html'); return; }

      const resp = NSHTTPURLResponse.alloc().initWithURLStatusCodeHTTPVersionHeaderFields(
        url, 404, 'HTTP/1.1', { 'Content-Length': '0' } as unknown as NSDictionary<string, string>
      );
      task.didReceiveResponse(resp);
      task.didFinish();
    }
    webViewStopURLSchemeTask(_webView: WKWebView, _task: WKURLSchemeTask): void {
      // single-shot responses; in-flight proxy completions are guarded by try/catch.
    }
  }
  return AppSchemeHandler.new();
}
