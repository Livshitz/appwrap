import { WebView, knownFolders, path as nsPath, File } from '@nativescript/core';
import { SHELL_CONFIG } from './config';
import { mimeFor } from './mime';
import { APPWRAP_GLOBALS_JS, NATIVE_FEEL_JS, mediaCaptureGuardJs, serviceWorkerGuardJs, externalNavGuardJs } from './web-quirks';
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

export class CustomWebView extends WebView {
  /** Set by the bridge before load; receives raw envelope JSON. */
  onAppwrapMessage: ((json: string) => void) | null = null;
  private _scriptHandler!: AppwrapScriptHandler; // retained — WKUserContentController holds it weakly
  private _logHandler!: AppwrapLogHandler; // retained — debug console-forwarding handler
  private _schemeHandler!: WKURLSchemeHandler;
  // NOT `_uiDelegate`: the base NativeScript WebView uses that exact field name, and
  // TS `private` is compile-time only — sharing it let super.initNativeView() overwrite
  // our media-capture delegate with NS's, so getUserMedia re-prompted every call.
  private _appwrapUiDelegate!: WKUIDelegate; // retained — WKWebView holds uiDelegate weakly

  /** No-op on iOS: WKWebView suspends rAF/timers itself when the app leaves the foreground.
   * Kept for parity with the Android impl (wired to suspend/resume in main-page). */
  setRenderingActive(_active: boolean): void {
    /* OS-managed on iOS */
  }

  createNativeView(): WKWebView {
    const config = WKWebViewConfiguration.new();
    config.allowsInlineMediaPlayback = true;
    config.allowsPictureInPictureMediaPlayback = true;
    config.mediaTypesRequiringUserActionForPlayback = 0; // WKAudiovisualMediaTypeNone
    config.websiteDataStore = WKWebsiteDataStore.defaultDataStore();

    // Env hints + framework globals (backend origin) + a getUserMedia guard for UNDECLARED capabilities
    // (must reject in JS before WebKit's native capture path — see mediaCaptureGuardJs) + native-feel
    // suppression, all injected before the page's own scripts run. Globals first so the page can read
    // __APPWRAP__ / __APPWRAP_BACKEND_ORIGIN__.
    const hasPlistKey = (k: string) => !!NSBundle.mainBundle.objectForInfoDictionaryKey(k);
    const mediaGuard = mediaCaptureGuardJs(hasPlistKey('NSCameraUsageDescription'), hasPlistKey('NSMicrophoneUsageDescription'));
    const swGuard = serviceWorkerGuardJs(SHELL_CONFIG.neutralizeServiceWorker);
    const extNavGuard = externalNavGuardJs(SHELL_CONFIG.openNewWindowsInBrowser);
    for (const src of [envGlobalsJs(), APPWRAP_GLOBALS_JS, mediaGuard, swGuard, extNavGuard, NATIVE_FEEL_JS]) {
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

  initNativeView(): void {
    super.initNativeView();
    // NativeScript's WebView assigns its own wkWebView.UIDelegate during init,
    // which clobbers the media-capture grant set in createNativeView — so WebKit
    // falls back to prompting on every getUserMedia call. Reassert ours last so
    // the `.grant` sticks: iOS then prompts once (TCC), like a native app.
    const wk = this.nativeViewProtected as WKWebView;
    if (wk && this._appwrapUiDelegate) wk.UIDelegate = this._appwrapUiDelegate;
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
