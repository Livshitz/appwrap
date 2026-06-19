import { WebView, Utils, knownFolders, path as nsPath, File } from '@nativescript/core';
import { SHELL_CONFIG } from './config';
import { mimeFor } from './mime';
import { APPWRAP_GLOBALS_JS, NATIVE_FEEL_JS, serviceWorkerGuardJs } from './web-quirks';
import { envGlobalsJs } from './env';
import { requestPermissions } from './android-helpers';

declare const android: any, java: any, androidx: any;

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
  return `${envGlobalsJs()}\n${APPWRAP_GLOBALS_JS}\n${TRANSPORT_SHIM}\n${serviceWorkerGuardJs(SHELL_CONFIG.neutralizeServiceWorker)}\n${NATIVE_FEEL_JS}`;
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

  initNativeView(): void {
    super.initNativeView();
    const wv = this.android;
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
    wv.setWebViewClient(createAssetServingClient());
    wv.setWebChromeClient(this.createTransportChromeClient());
  }

  /**
   * Stop/restart the WebView's render + JS-timer pipeline when the app is backgrounded/foregrounded
   * (wired to Application suspend/resume in main-page). Android does NOT reliably halt rAF/CSS
   * animations when the activity isn't visible, so a page running a continuous animation keeps the
   * compositor — and the CPU — busy in the background. onPause()/pauseTimers() stops that; the latter
   * is process-wide but harmless with our single WebView. iOS suspends rAF on its own (no-op there).
   */
  setRenderingActive(active: boolean): void {
    const wv = this.android;
    if (!wv) return;
    try {
      if (active) { wv.onResume(); wv.resumeTimers(); }
      else { wv.onPause(); wv.pauseTimers(); }
    } catch (e) {
      console.warn('AppWrap: setRenderingActive failed', e);
    }
  }

  private installDocumentStartShim(wv: any): void {
    try {
      const wkt = androidx.webkit;
      if (wkt.WebViewFeature.isFeatureSupported(wkt.WebViewFeature.DOCUMENT_START_SCRIPT)) {
        const rules = new java.util.HashSet();
        rules.add(APP_ORIGIN);
        wkt.WebViewCompat.addDocumentStartJavaScript(wv, buildBootstrapJs(), rules);
        return;
      }
      console.warn('AppWrap: DOCUMENT_START_SCRIPT unsupported — relying on onPageStarted shim');
    } catch (e) {
      console.warn('AppWrap: addDocumentStartJavaScript failed', e);
    }
  }

  private createTransportChromeClient(): any {
    const owner = new WeakRef<CustomWebView>(this);
    const ChromeClient = (android.webkit.WebChromeClient as any).extend({
      onJsPrompt(_view: any, _url: string, message: string, _defaultValue: string, result: any): boolean {
        if (typeof message === 'string' && message.startsWith(PROMPT_PREFIX)) {
          result.confirm('');
          const view = owner.get ? owner.get() : (owner as any).deref();
          view?.onAppwrapMessage?.(message.slice(PROMPT_PREFIX.length));
          return true;
        }
        return false; // genuine page prompt — default handling
      },

      // getUserMedia: grant the WebView's per-origin capture after ensuring the
      // app holds the matching OS runtime permission (CAMERA / RECORD_AUDIO).
      onPermissionRequest(request: any): void {
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
    });
    return new ChromeClient();
  }
}

/** https://appwrap.local/<path> → file under www/; SPA fallback to the entry for extension-less misses. */
function createAssetServingClient(): any {
  const wwwPath = nsPath.join(knownFolders.currentApp().path, 'www');

  const respond = (filePath: string, ext: string) => {
    const stream = new java.io.FileInputStream(filePath);
    return new android.webkit.WebResourceResponse(mimeFor(ext, filePath), 'utf-8', stream);
  };

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
  const proxyToBackend = (rel: string, query: string, ext: string, method: string, headers: any): any => {
    if (method !== 'GET' && method !== 'HEAD') {
      return new android.webkit.WebResourceResponse(
        'text/plain', 'utf-8', 501, 'Not Implemented', new java.util.HashMap(),
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
        let is: any = null;
        try {
          const conn = new java.net.URL(target).openConnection();
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
    const outHeaders = new java.util.HashMap();
    outHeaders.put('Access-Control-Allow-Origin', '*');
    outHeaders.put('Cache-Control', 'no-cache');
    // mime/charset best-effort from the path; status 200 (real status is unknown until the bg read).
    return new android.webkit.WebResourceResponse(mimeFor(ext, rel), 'utf-8', 200, 'OK', outHeaders, pin);
  };

  const Client = (android.webkit.WebViewClient as any).extend({
    shouldInterceptRequest(_view: any, request: any): any {
      const isObj = typeof request !== 'string';
      const url: string = isObj ? String(request.getUrl().toString()) : request;
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
        const method = (isObj && request.getMethod && String(request.getMethod())) || 'GET';
        const headers = isObj && request.getRequestHeaders ? request.getRequestHeaders() : null;
        return proxyToBackend(rel, query, ext, method.toUpperCase(), headers);
      }
      return new android.webkit.WebResourceResponse(
        'text/plain', 'utf-8', 404, 'Not Found', new java.util.HashMap(), emptyStream()
      );
    },

    onPageStarted(view: any, _url: string, _favicon: any): void {
      // Fallback injection — no-op when the document-start scripts already ran
      view.evaluateJavascript(buildBootstrapJs(), null);
    },

    // `appwrap dev` points at a LAN dev server that almost always uses a self-signed / mkcert TLS
    // cert the device's trust store doesn't know — the WebView would otherwise hard-fail with
    // ERR_CERT_AUTHORITY_INVALID. Proceed past it ONLY in a debug build AND only when actually in
    // server-loader (dev) mode. Production app:// builds never reach this (local assets, no TLS).
    onReceivedSslError(_view: any, handler: any, error: any): void {
      if (SHELL_CONFIG.debug && SHELL_CONFIG.loader === 'server') {
        console.warn('AppWrap: proceeding past dev-server SSL error (debug+server only):', String(error));
        handler.proceed();
      } else {
        handler.cancel();
      }
    },
  });
  return new Client();
}
