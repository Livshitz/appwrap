import { WebView, Utils, knownFolders, path as nsPath, File } from '@nativescript/core';
import { SHELL_CONFIG } from './config';
import { mimeFor } from './mime';
import { APPWRAP_GLOBALS_JS, NATIVE_FEEL_JS, serviceWorkerGuardJs, externalNavGuardJs } from './web-quirks';
import { envGlobalsJs } from './env';
import { requestPermissions } from './android-helpers';
import { showFileChooser } from './file-chooser.android';
import { hostOf } from './env-switcher';

// `android` + `java` resolve to the real types-android namespaces (no declare needed).
declare const androidx: any; // no NS types: androidx.webkit.* (WebViewFeature/WebViewCompat) not in the android-32 platform typings

/** Stable in-app origin — secure context, ES modules work (file:// blocks them). */
export const APP_ORIGIN = 'https://appwrap.local';

/**
 * Web→native transport shim. postMessage tunnels through window.prompt(), which
 * the shell intercepts synchronously in WebChromeClient.onJsPrompt — no compiled
 * @JavascriptInterface class, no polling. Injected at document start (androidx.webkit)
 * with an onPageStarted fallback; the guard makes double-injection a no-op.
 */
const TRANSPORT_SHIM = `(function(){
  if (window.appwrapNative) return;
  window.appwrapNative = { postMessage: function(json){ window.prompt('__appwrap__:' + json); } };
})();`;

const PROMPT_PREFIX = '__appwrap__:';

/** Document-start scripts: env hints + framework globals (backend origin) + bridge transport +
 * native-feel. Globals first so the page can read __APPWRAP__ / __APPWRAP_BACKEND_ORIGIN__ before its
 * own scripts run. Built lazily (not a const) so envGlobalsJs() detects against a live activity context. */
function buildBootstrapJs(): string {
  return `${envGlobalsJs()}\n${APPWRAP_GLOBALS_JS}\n${TRANSPORT_SHIM}\n${serviceWorkerGuardJs(SHELL_CONFIG.neutralizeServiceWorker)}\n${externalNavGuardJs(SHELL_CONFIG.openNewWindowsInBrowser)}\n${NATIVE_FEEL_JS}`;
}

/**
 * The extended WebChromeClient MUST be generated ONCE. NativeScript caches the Java proxy
 * class it synthesizes for `extend({...})` keyed by the methods-object shape, so calling
 * extend() again per-webview REUSES the first invocation's class — including its captured
 * closure. A per-instance `owner` WeakRef baked into the closure therefore cross-wires every
 * later webview's prompt() transport to the FIRST instance (device-proven in the feedox
 * mini-app spike: webview-2's bridge request was answered as webview-1). Route by the native
 * view the callback is given instead, resolved against a per-view registry.
 */
let chromeClientClass: any;
function getChromeClientClass(): any {
  if (chromeClientClass) return chromeClientClass;
  // NS runtime adds `.extend` on Java classes; it's not in the static typings, hence the cast.
  chromeClientClass = (android.webkit.WebChromeClient as any).extend({
    onJsPrompt(
      view: android.webkit.WebView,
      _url: string,
      message: string,
      _defaultValue: string,
      result: android.webkit.JsPromptResult
    ): boolean {
      if (typeof message === 'string' && message.startsWith(PROMPT_PREFIX)) {
        result.confirm('');
        CustomWebView.forNative(view)?.onAppwrapMessage?.(message.slice(PROMPT_PREFIX.length));
        return true;
      }
      return false; // genuine page prompt — default handling
    },

    // getUserMedia: grant the WebView's per-origin capture after ensuring the
    // app holds the matching OS runtime permission (CAMERA / RECORD_AUDIO).
    // No instance state — safe on the shared class.
    onPermissionRequest(request: android.webkit.PermissionRequest): void {
      const PR = android.webkit.PermissionRequest;
      const resources: string[] = Array.from(request.getResources());
      const perms = new Set<string>();
      for (const r of resources) {
        if (r === PR.RESOURCE_VIDEO_CAPTURE) perms.add('android.permission.CAMERA');
        if (r === PR.RESOURCE_AUDIO_CAPTURE) perms.add('android.permission.RECORD_AUDIO');
      }
      if (!perms.size) {
        Utils.dispatchToMainThread(() => request.grant(request.getResources()));
        return;
      }
      requestPermissions(Array.from(perms)).then((ok) =>
        Utils.dispatchToMainThread(() => (ok ? request.grant(request.getResources()) : request.deny()))
      );
    },

    // <input type="file"> — NOT optional here: replacing NS's WebChromeClient removed the
    // platform's default handling, so without this the input is completely inert. All state is
    // per-invocation closure state inside showFileChooser (the class is shared across webviews).
    onShowFileChooser(
      _view: android.webkit.WebView,
      filePathCallback: android.webkit.ValueCallback<androidNative.Array<android.net.Uri>>,
      fileChooserParams: android.webkit.WebChromeClient.FileChooserParams
    ): boolean {
      return showFileChooser(filePathCallback, fileChooserParams);
    },
  });
  return chromeClientClass;
}

/**
 * Android CustomWebView — replaces NS's default clients after creation:
 * WebChromeClient.onJsPrompt is the appwrap transport, WebViewClient
 * intercepts https://appwrap.local/* and serves the bundled PWA from www/
 * (mirror of the iOS app:// WKURLSchemeHandler).
 */
export class CustomWebView extends WebView {
  /** Set by the bridge before load; receives raw envelope JSON. */
  onAppwrapMessage: ((json: string) => void) | null = null;

  /**
   * A TLS handshake this view REFUSED (onReceivedSslError → handler.cancel()), pending attribution to the
   * navigation it killed. Cancelling an SSL error does NOT route through onReceivedError — Chromium instead
   * swaps in its own error page and reports it via onPageFinished with the ORIGINAL url, which would read as
   * a SUCCESSFUL load (see `pageFinished`). Recorded here so that onPageFinished can tell the two apart.
   * Host-scoped (a cert is per-host, so a same-host sub-resource can't fail while the main frame succeeds),
   * and cleared on any COMMITTED navigation (`pageStarted`) — a refused one never commits, so the record
   * always outlives the failure it describes and never leaks onto the next page.
   */
  pendingSslError: { host: string; reason: string } | null = null;

  // STRONG JS references to the native clients. Chromium holds the Java WebViewClient /
  // WebChromeClient, but NativeScript's mark-and-sweep does NOT treat that native hold as a
  // GC root — so without a JS-side reference the JS peer gets collected under memory pressure
  // (e.g. heavy scrolling), and the next background-thread shouldInterceptRequest crashes with
  // "Cannot find runtime for instance". Retaining here (mirrors @nativescript/core's
  // `nativeView.client = client`) keeps the peer alive for the WebView's lifetime.
  private webViewClient: android.webkit.WebViewClient | null = null;
  private webChromeClient: android.webkit.WebChromeClient | null = null;

  // Native-view → owning CustomWebView, keyed by the Java identity hash (stable per native
  // object, robust to NS re-wrapping the arg passed into the ChromeClient callback). WeakRef
  // so a destroyed view can be GC'd; entry pruned on dispose.
  private static registry = new Map<number, WeakRef<CustomWebView>>();
  // Retired asset-serving WebViewClients (app/file loader ONLY — see disposeNativeView), kept
  // process-alive so a shouldInterceptRequest already in flight on a background thread when the view is
  // disposed can't fire against a GC'd JS peer → "Cannot find runtime for instance". Holding the (JS-peer)
  // object here keeps NS's per-object runtime mapping resolvable. Server mode installs no interceptor, so
  // its clients are NOT parked (all their callbacks are main-thread → safe to GC). Growth is bounded by
  // the number of interceptor-bearing WebViews that dispose — note handlers-background can spin up an
  // offscreen WebView per background task, so this is per-disposed-interceptor-view, not strictly one.
  private static retiredClients = new Set<android.webkit.WebViewClient>();
  static forNative(view: android.webkit.WebView): CustomWebView | undefined {
    const owner = CustomWebView.registry.get(view.hashCode())?.deref();
    // identityHashCode is not unique: on a (rare) collision the map holds the LAST writer —
    // re-check native identity so a colliding view drops rather than cross-wires.
    if (owner && owner.android !== view) return undefined;
    return owner;
  }

  initNativeView(): void {
    super.initNativeView();
    // NS core types the `.android` getter as `any`; narrow to the real WebView for this scope.
    const wv = this.android as android.webkit.WebView;
    if (!wv) return;

    // Debug mode only: debuggable via chrome://inspect (full console + network) + keep the screen
    // awake while foreground for continuous troubleshooting. Off in store builds.
    if (SHELL_CONFIG.debug) {
      try { android.webkit.WebView.setWebContentsDebuggingEnabled(true); } catch (e) { /* older API */ }
      try { wv.setKeepScreenOn(true); } catch (e) { /* no-op */ }
    }

    const settings = wv.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(true);
    settings.setMediaPlaybackRequiresUserGesture(false); // speaker: autoplay allowed
    // Native feel: no pinch-zoom controls.
    settings.setSupportZoom(false);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    // No rubber-band overscroll glow.
    wv.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);

    this.installDocumentStartShim(wv);
    // Retain both clients in long-lived JS fields (see field docs) so their JS peers survive GC
    // for the WebView's lifetime — otherwise a background-thread shouldInterceptRequest can fire
    // after the peer is collected and crash with "Cannot find runtime for instance".
    this.webViewClient = createAssetServingClient();
    wv.setWebViewClient(this.webViewClient);
    // Bind THIS native view to THIS instance before wiring the (shared, extend-once) client.
    CustomWebView.registry.set(wv.hashCode(), new WeakRef<CustomWebView>(this));
    this.webChromeClient = new (getChromeClientClass())();
    wv.setWebChromeClient(this.webChromeClient);
  }

  disposeNativeView(): void {
    const wv = this.android as android.webkit.WebView | undefined;
    if (wv) CustomWebView.registry.delete(wv.hashCode());
    // WebChromeClient (onJsPrompt) only fires on the main thread → safe to release for GC now.
    this.webChromeClient = null;
    // WebViewClient is different: shouldInterceptRequest can be dispatched on a BACKGROUND thread, so a
    // request already in flight when the view tears down would fire AFTER dispose. Releasing the client's
    // JS peer here would let that late off-thread call crash with "Cannot find runtime for instance".
    // Park it in a process-lived set so the peer stays registered for any straggler callback — but ONLY
    // when the interceptor is actually installed (app/file loader). Server mode installs no
    // shouldInterceptRequest (see createAssetServingClient), so its client has no off-thread callback to
    // outlive dispose: parking it would be pure dead retention (an accumulating leak across background-
    // task WebViews), so just release it for GC.
    if (this.webViewClient) {
      if (SHELL_CONFIG.loader !== 'server') CustomWebView.retiredClients.add(this.webViewClient);
      this.webViewClient = null;
    }
    super.disposeNativeView();
  }

  /**
   * Stop/restart the WebView's render + JS-timer pipeline when the app is backgrounded/foregrounded
   * (wired to Application suspend/resume in main-page). Android does NOT reliably halt rAF/CSS
   * animations when the activity isn't visible, so a page running a continuous animation keeps the
   * compositor — and the CPU — busy in the background. onPause()/pauseTimers() stops that; the latter
   * is process-wide but harmless with our single WebView. iOS suspends rAF on its own (no-op there).
   */
  setRenderingActive(active: boolean): void {
    const wv = this.android as android.webkit.WebView;
    if (!wv) return;
    try {
      if (active) { wv.onResume(); wv.resumeTimers(); }
      else { wv.onPause(); wv.pauseTimers(); }
    } catch (e) {
      console.warn('AppWrap: setRenderingActive failed', e);
    }
  }

  /** iOS-only renderer-wake (see custom-webview.ios.ts). No-op on Android: onResume()/resumeTimers()
   * in setRenderingActive already restart the WebView pipeline on foreground. */
  wakeWebContent(): void {
    /* iOS-only */
  }

  /** iOS-only post-native-surface recovery (see custom-webview.ios.ts). No-op on Android: dismissing a
   * native screen returns through the normal activity resume, which already restores the WebView. */
  recoverAfterNativeSurface(): void {
    /* iOS-only */
  }

  private installDocumentStartShim(wv: android.webkit.WebView): void {
    try {
      const wkt = androidx.webkit;
      if (wkt.WebViewFeature.isFeatureSupported(wkt.WebViewFeature.DOCUMENT_START_SCRIPT)) {
        const rules = new java.util.HashSet<string>();
        rules.add(APP_ORIGIN);
        // loader:'server' loads a REMOTE origin (serverUrl), not the app:// bundle. The document-start
        // bridge shim must be allowed THERE too — otherwise it only lands via the onPageStarted
        // fallback, which RACES the page's native-kit detect(): it sees no `window.appwrapNative`,
        // falls back to the web adapter, and NO native capability works (share/widget/pin all report
        // 'none'). Adding the server origin injects the bridge before any page script runs.
        const serverOrigin = SHELL_CONFIG.loader === 'server'
          ? (String(SHELL_CONFIG.serverUrl).match(/^https?:\/\/[^/]+/)?.[0] ?? '')
          : '';
        if (serverOrigin) rules.add(serverOrigin);
        wkt.WebViewCompat.addDocumentStartJavaScript(wv, buildBootstrapJs(), rules);
        return;
      }
      console.warn('AppWrap: DOCUMENT_START_SCRIPT unsupported — relying on onPageStarted shim');
    } catch (e) {
      console.warn('AppWrap: addDocumentStartJavaScript failed', e);
    }
  }
}

/** https://appwrap.local/<path> → file under www/; SPA fallback to the entry for extension-less misses.
 * Extend-once (same NS shape-caching pitfall as the ChromeClient above): the closure here is
 * process-constant, but generating the class per webview would silently pin the FIRST call's
 * closure anyway — build it once and reuse. */
let assetClientClass: any;
function createAssetServingClient(): android.webkit.WebViewClient {
  if (assetClientClass) return new assetClientClass();
  const wwwPath = nsPath.join(knownFolders.currentApp().path, 'www');

  const respond = (filePath: string, ext: string): android.webkit.WebResourceResponse => {
    const stream = new java.io.FileInputStream(filePath);
    return new android.webkit.WebResourceResponse(mimeFor(ext, filePath), 'utf-8', stream);
  };

  // (Array as any).create is the NS interop helper for native byte[]; not in lib typings.
  const emptyStream = () => new java.io.ByteArrayInputStream((Array as any).create('byte', 0));

  /**
   * PROXY a non-local path to the backend (mirror of the iOS scheme-handler proxy) so a
   * same-origin PWA's relative /api, /functions and vendor (/_vendor/sdk.js) requests resolve
   * under app://appwrap.local — no CORS, same-origin.
   *
   * THREADING: NativeScript marshals the shouldInterceptRequest JS callback onto the JS/main thread,
   * so a synchronous HttpURLConnection here throws NetworkOnMainThreadException. Instead we return
   * immediately with a PipedInputStream and do the network read on a background java.lang.Thread that
   * pumps the body into the pipe — the WebView drains it lazily. mime/charset are best-effort from the
   * path extension (we can't read upstream headers without first blocking).
   *
   * LIMITATION: Android's shouldInterceptRequest exposes no request body, so only body-less methods
   * (GET/HEAD) are proxied — POST/PUT/PATCH return 501 rather than silently sending an empty body.
   * (BodDB writes ride the WS, not HTTP POST, so this is rarely hit.)
   */
  const proxyToBackend = (
    rel: string,
    query: string,
    ext: string,
    method: string,
    headers: java.util.Map<string, string> | null
  ): android.webkit.WebResourceResponse => {
    if (method !== 'GET' && method !== 'HEAD') {
      return new android.webkit.WebResourceResponse(
        'text/plain', 'utf-8', 501, 'Not Implemented', new java.util.HashMap<string, string>(),
        new java.io.ByteArrayInputStream(new java.lang.String(
          'appwrap Android shell cannot proxy request bodies (shouldInterceptRequest limitation)'
        ).getBytes('UTF-8'))
      );
    }
    const pin = new java.io.PipedInputStream(1 << 16);
    const pout = new java.io.PipedOutputStream(pin);
    const target = `${SHELL_CONFIG.backendOrigin.replace(/\/+$/, '')}/${rel}${query}`;
    const pump = new java.lang.Runnable({
      run() {
        let is: java.io.InputStream | null = null;
        try {
          // openConnection() statically returns URLConnection; for http(s) it's an HttpURLConnection.
          const conn = new java.net.URL(target).openConnection() as java.net.HttpURLConnection;
          conn.setRequestMethod(method);
          conn.setInstanceFollowRedirects(true);
          conn.setConnectTimeout(15000);
          conn.setReadTimeout(20000);
          if (headers) {
            const it = headers.entrySet().iterator();
            while (it.hasNext()) {
              const e = it.next();
              const k = String(e.getKey());
              if (k.toLowerCase() === 'host') continue; // let URLConnection set Host from the target
              conn.setRequestProperty(k, String(e.getValue()));
            }
          }
          conn.connect();
          const status = conn.getResponseCode();
          is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
          const buf = (Array as any).create('byte', 16384);
          let n: number;
          while (is && (n = is.read(buf)) !== -1) pout.write(buf, 0, n);
        } catch (e) {
          console.log('[appwrap] proxy failed for /' + rel + ': ' + e);
        } finally {
          try { if (is) is.close(); } catch (e) { /* no-op */ }
          try { pout.close(); } catch (e) { /* no-op */ }
        }
      },
    });
    new java.lang.Thread(pump).start();
    const outHeaders = new java.util.HashMap<string, string>();
    outHeaders.put('Access-Control-Allow-Origin', '*');
    outHeaders.put('Cache-Control', 'no-cache');
    // mime/charset best-effort from the path; status 200 (real status is unknown until the bg read).
    return new android.webkit.WebResourceResponse(mimeFor(ext, rel), 'utf-8', 200, 'OK', outHeaders, pin);
  };

  // WebViewClient callbacks. All are dispatched on the UI/main thread EXCEPT shouldInterceptRequest,
  // which Android runs on a BACKGROUND thread (ShouldInterceptRequestMediator). NativeScript resolves
  // the JS peer for a callback's instance via a per-object runtime lookup (Runtime.getObjectRuntime);
  // if that peer is momentarily unregistered — freshly created and not yet mapped on boot, or disposed
  // and GC'd on relaunch / RESTART-from-crash — the off-thread call throws
  // `NativeScriptException: Cannot find runtime for instance` (the red NS crash screen). NS marshals a
  // background-thread call to the main thread fine ONCE the peer is mapped, so this is a registration/
  // lifetime race, not a plain GC one — which is why the earlier strong-JS-ref fix didn't cover the boot path.
  //
  // In server mode (loader:'server') the page loads from a real https `serverUrl`: there are NO
  // https://appwrap.local requests and `backendOrigin` is same-origin, so the asset interceptor does
  // ZERO work — yet it is the ONLY off-main-thread callback, i.e. the only one exposed to that race.
  // So OMIT it in server mode (the server-mode literal below simply doesn't declare it): Android's default
  // pure-Java interception runs, NS is never crossed into JS off-thread, and the crash is structurally
  // impossible. This omission was originally written as a conditional spread — see the SBG warning below
  // for why that shape silently broke the build and must not come back.
  // app/file loaders MUST serve bundled www/ assets, so they keep it (and retain the client for the
  // process lifetime — see CustomWebView.disposeNativeView — so a late in-flight call can't hit a dead peer).
  // NS runtime adds `.extend` on Java classes; it's not in the static typings, hence the cast.
  // Modern (API 21+) overload passes a WebResourceRequest; the legacy overload passed a string URL.
  // We defensively handle both, so the param is the union.
  const interceptRequest = (
    request: android.webkit.WebResourceRequest | string
  ): android.webkit.WebResourceResponse | null => {
      const url: string = typeof request !== 'string' ? String(request.getUrl().toString()) : request;
      if (!url.startsWith(APP_ORIGIN)) return null; // external — let WebView handle it

      const tail = url.slice(APP_ORIGIN.length);
      const qIdx = tail.search(/[?#]/);
      const query = qIdx >= 0 && tail[qIdx] === '?' ? tail.slice(qIdx).split('#')[0] : '';
      let rel = decodeURIComponent(tail.split(/[?#]/)[0]).replace(/^\/+/, '');
      if (!rel) rel = SHELL_CONFIG.entry;
      let filePath = nsPath.join(wwwPath, rel);
      const ext = rel.includes('.') ? rel.split('.').pop()!.toLowerCase() : '';

      if (File.exists(filePath)) return respond(filePath, ext);

      if (!ext) {
        // extension-less navigation → SPA fallback
        return respond(nsPath.join(wwwPath, SHELL_CONFIG.entry), 'html');
      }
      // Not a local asset → proxy to the backend (mirror of iOS), making relative
      // backend/vendor requests same-origin under app://appwrap.local.
      if (SHELL_CONFIG.backendOrigin) {
        const isObj = typeof request !== 'string';
        const method = (isObj && request.getMethod && String(request.getMethod())) || 'GET';
        const headers = isObj && request.getRequestHeaders ? request.getRequestHeaders() : null;
        return proxyToBackend(rel, query, ext, method.toUpperCase(), headers);
      }
      return new android.webkit.WebResourceResponse(
        'text/plain', 'utf-8', 404, 'Not Found', new java.util.HashMap<string, string>(), emptyStream()
      );
  };

  // External URL schemes (mailto:/tel:/sms:/geo:/intent:/webcal:/market:/…) can't be rendered by the
  // WebView — without this override it tries to LOAD them and dumps a full-page net::ERR_UNKNOWN_URL_SCHEME
  // over the app. Hand every non-WebView scheme to the OS via ACTION_VIEW (intent: via parseUri) and
  // return true so the WebView never navigates. http/https/file/about/blob/data/javascript stay in-WebView.
  const overrideUrlLoading = (
    view: android.webkit.WebView,
    request: android.webkit.WebResourceRequest | string
  ): boolean => {
      const url: string = typeof request !== 'string' ? String(request.getUrl().toString()) : request;
      const scheme = (url.split(':')[0] || '').toLowerCase();
      if (['http', 'https', 'file', 'about', 'blob', 'data', 'javascript'].includes(scheme)) return false;
      try {
        const intent = scheme === 'intent'
          ? android.content.Intent.parseUri(url, android.content.Intent.URI_INTENT_SCHEME)
          : new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
          view.getContext().startActivity(intent);
        } catch (notInstalled) {
          // Target app missing. intent: URLs carry `browser_fallback_url` for exactly this (Chrome
          // semantics — e.g. "add to Google Calendar" falls back to the web calendar). Honor it via the
          // OS browser rather than silently dropping the action.
          const fallback = scheme === 'intent' && intent.getStringExtra('browser_fallback_url');
          if (!fallback) throw notInstalled;
          const fb = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(String(fallback)));
          fb.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
          view.getContext().startActivity(fb);
        }
      } catch (e) {
        // No installed app handles the scheme / no fallback — swallow (better a no-op than an error page).
        console.warn('[appwrap] no OS handler for external URL: ' + url + ' (' + e + ')');
      }
      return true;
  };

  const pageStarted = (view: android.webkit.WebView): void => {
      // A navigation COMMITTED, so any earlier TLS refusal is answered for — drop it (see pendingSslError).
      // A refused nav never reaches here (device-verified on WebView 138: no onPageStarted on an SSL cancel),
      // so this cannot clear the record before `pageFinished` reads it.
      //
      // ⚠️ That is UNDOCUMENTED Chromium behaviour, not a contract. If a future WebView fires onPageStarted
      // for its own error-page commit (i.e. AFTER onReceivedSslError), this clears the record and the
      // swallowed-as-success bug returns SILENTLY. If that regresses, look here first.
      // Redirects are safe for a stronger reason than the above: on http://x → 302 → https://y(bad),
      // onPageStarted(x) fires BEFORE the handshake, so it clears an OLDER record and the refusal is
      // recorded after — clear-before-write ordering holds regardless.
      const owner = CustomWebView.forNative(view);
      if (owner) owner.pendingSslError = null;
      // Fallback injection — no-op when the document-start scripts already ran
      view.evaluateJavascript(buildBootstrapJs(), null as unknown as android.webkit.ValueCallback<string>);
  };

  // Main-frame load FAILURE → NativeScript's `loadFinished` event (its `error` arg). We replace NS's own
  // WebViewClientImpl wholesale (see initNativeView), and NS only raises that event from ITS client — so
  // without this forward the event NEVER fires on Android and a failed load (server down, DNS, refused)
  // is invisible to JS. iOS keeps the event because DevCertNavDelegate forwards didFail*Navigation to
  // NS's delegate; this restores the SAME seam here rather than adding a parallel Android-only one
  // (consumer: env-switcher's reloadToEffective).
  // MAIN FRAME ONLY: API 23+ also reports sub-resource failures here, and a dead favicon/image must not
  // be mistaken for "the page didn't load". minSdk is 26, so only this modern overload is ever dispatched
  // (the legacy string-arg overload is API < 23).
  const receivedError = (
    view: android.webkit.WebView,
    request: android.webkit.WebResourceRequest,
    error: android.webkit.WebResourceError
  ): void => {
      if (!request?.isForMainFrame?.()) return;
      // `_onLoadFinished` is NS's internal event-raiser (the `_` API index.android.js itself calls) — not
      // in the public typings, hence the cast.
      (CustomWebView.forNative(view) as any)?._onLoadFinished(
        String(request.getUrl?.() ?? ''),
        `${error?.getDescription?.() ?? 'Load failed'} (${error?.getErrorCode?.() ?? '?'})`
      );
  };

  // Main-frame load SUCCESS → NativeScript's `loadFinished` event with NO `error` arg. The counterpart of
  // `receivedError` above, and NOT optional: NS raises this from ITS WebViewClientImpl.onPageFinished,
  // which we replace wholesale — so forwarding only the FAILURE half would leave `loadFinished` never
  // firing on a SUCCESSFUL load. A one-shot `loadFinished` listener (env-switcher's reloadToEffective)
  // would then never unhook on success and would leak onto the NEXT navigation, blaming a later error on
  // an earlier switch (and naming the earlier switch's host). Both halves or neither.
  //
  // …EXCEPT this callback is ALSO how Chromium reports its OWN error page after a REFUSED TLS handshake
  // (device-verified sequence: onReceivedSslError → handler.cancel() → onPageFinished with the original
  // url, and NO onReceivedError). Forwarding that as a success is what silently swallowed a cert failure
  // into a blank page — and it unhooked the env-switcher's one-shot listener too, so the failure could
  // never be reported at all. Attribute it via the recorded refusal instead (see pendingSslError).
  const pageFinished = (view: android.webkit.WebView, url: string): void => {
      const owner = CustomWebView.forNative(view);
      const finishedUrl = String(url ?? '');
      const ssl = owner?.pendingSslError;
      if (ssl && ssl.host === hostOf(finishedUrl)) {
        owner!.pendingSslError = null;
        (owner as any)?._onLoadFinished(finishedUrl, ssl.reason);
        return;
      }
      // Mirrors NS's own `owner._onLoadFinished(url, undefined)` — absent `error` is what marks success.
      (owner as any)?._onLoadFinished(finishedUrl);
  };

  /** Android SslError primary codes → why the cert was rejected (SslError.SSL_* ordinals). */
  const SSL_REASONS: Record<number, string> = {
    0: 'the certificate is not valid yet',
    1: 'the certificate has expired',
    2: "the certificate's hostname does not match",
    3: 'the certificate issuer is not trusted',
    4: 'the certificate date is invalid',
    5: 'the certificate is invalid',
  };

  // DEBUG-ONLY dev-server cert trust (Android parity with the iOS WKNavigationDelegate). `appwrap dev`
  // points at a LAN dev server that almost always uses a self-signed / mkcert TLS cert the device's
  // trust store doesn't know — the WebView would otherwise hard-fail with ERR_CERT_AUTHORITY_INVALID.
  // Proceed past it ONLY in a debug build, only in server-loader mode, AND only for the ONE host the
  // build-time host (`SHELL_CONFIG.serverUrl`, NOT the switchable override) — never blanket-trust every host. Production app:// builds
  // never reach this (local assets, no TLS). NEVER active in a store build (SHELL_CONFIG.debug false).
  //
  // NOT trusting it is a LOAD FAILURE, and Chromium reports it through no other callback — so the cancel
  // path RECORDS the refusal on the owning view for `pageFinished` to raise as `loadFinished(error)`.
  // Without that the whole cert class is invisible to JS (blank page, no feedback) — the exact incident the
  // env-switcher's reload feedback exists to name.
  const receivedSslError = (
    view: android.webkit.WebView,
    handler: android.webkit.SslErrorHandler,
    error: android.net.http.SslError
  ): void => {
      // BUILD-TIME serverUrl host ONLY — never the switchable `effectiveServerUrl()` override (would let a
      // switched host's self-signed cert be trusted → MITM). The dev server is always the build-time URL.
      // Host WITHOUT port, mirroring the iOS DevCertNavDelegate (a dev server on :3000 and its HMR sub-
      // resources on an alt port share one self-signed cert) — same `hostOf` normalization + port strip.
      const stripPort = (h: string) => h.replace(/:\d+$/, '');
      const errUrl = String(error?.getUrl?.() ?? '');
      const allowedHost = stripPort(hostOf(SHELL_CONFIG.serverUrl));
      const errHost = stripPort(hostOf(errUrl));
      if (SHELL_CONFIG.debug && SHELL_CONFIG.loader === 'server' && !!allowedHost && errHost === allowedHost) {
        console.warn('AppWrap: trusting self-signed dev-server cert (debug + host-scoped):', errHost);
        handler.proceed();
        return;
      }
      const why = SSL_REASONS[error?.getPrimaryError?.()] ?? 'the certificate was rejected';
      const owner = CustomWebView.forNative(view);
      // Host WITH port here (unlike the trust match above) — this record is matched against the finished
      // url via the same `hostOf`, so both sides must normalize identically.
      if (owner) owner.pendingSslError = { host: hostOf(errUrl), reason: `TLS certificate rejected — ${why}.` };
      handler.cancel();
  };

  // TWO literals, selected by loader — NOT one literal with a conditional spread. Both the omission and
  // this shape are load-bearing:
  //   * The OMISSION (see the comment above) is what makes the off-thread race structurally impossible in
  //     server mode. Do not "simplify" this to one literal that always defines shouldInterceptRequest and
  //     early-returns null in server mode — the JS peer would still be crossed off-thread and the
  //     `Cannot find runtime for instance` crash returns.
  //   * The SHAPE must stay a spread-free object LITERAL of method shorthands. NativeScript's static
  //     binding generator parses every `X.extend({...})` literal and reads `prop.key.name` for each
  //     property: a SpreadElement has no `key`, so `...(cond ? {} : {...})` throws inside its js_parser,
  //     which then ABANDONS THE WHOLE FILE and still exits 0 — silently dropping every @JavaProxy binding
  //     declared later in the bundle (this cost us a FATAL `LookedUpClassNotFound:
  //     cc.livx.appwrap.AppwrapMessagingService` boot crash that built green). For the same reason don't
  //     hoist the object into a variable and pass `.extend(methods)`: SBG requires an ObjectExpression at
  //     the call site and silently skips anything else.
  //     ⚠️ NOTHING VERIFIES THIS. An earlier version of this comment claimed `appwrap doctor:bindings`
  //     (run by the android build) fails the build on a lost @JavaProxy binding — that command does not
  //     exist and no test asserts the shape. The requirement is hand-maintained. A lost binding means the
  //     callback silently never fires, which reads as "no TLS errors ever" — a green from something that
  //     never ran. Either implement the check or keep this warning honest; do not restore the false claim.
  assetClientClass = SHELL_CONFIG.loader === 'server'
    ? (android.webkit.WebViewClient as any).extend({
      shouldOverrideUrlLoading(view: android.webkit.WebView, request: android.webkit.WebResourceRequest | string): boolean {
        return overrideUrlLoading(view, request);
      },
      onPageStarted(view: android.webkit.WebView, _url: string, _favicon: android.graphics.Bitmap): void {
        pageStarted(view);
      },
      onPageFinished(view: android.webkit.WebView, url: string): void {
        pageFinished(view, url);
      },
      onReceivedSslError(view: android.webkit.WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError): void {
        receivedSslError(view, handler, error);
      },
      onReceivedError(view: android.webkit.WebView, request: android.webkit.WebResourceRequest, error: android.webkit.WebResourceError): void {
        receivedError(view, request, error);
      },
    })
    : (android.webkit.WebViewClient as any).extend({
      shouldInterceptRequest(_view: android.webkit.WebView, request: android.webkit.WebResourceRequest | string): android.webkit.WebResourceResponse | null {
        return interceptRequest(request);
      },
      shouldOverrideUrlLoading(view: android.webkit.WebView, request: android.webkit.WebResourceRequest | string): boolean {
        return overrideUrlLoading(view, request);
      },
      onPageStarted(view: android.webkit.WebView, _url: string, _favicon: android.graphics.Bitmap): void {
        pageStarted(view);
      },
      onPageFinished(view: android.webkit.WebView, url: string): void {
        pageFinished(view, url);
      },
      onReceivedSslError(view: android.webkit.WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError): void {
        receivedSslError(view, handler, error);
      },
      onReceivedError(view: android.webkit.WebView, request: android.webkit.WebResourceRequest, error: android.webkit.WebResourceError): void {
        receivedError(view, request, error);
      },
    });
  return new assetClientClass();
}
