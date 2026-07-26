import { isAndroid, isIOS } from '@nativescript/core';
import { CustomWebView } from './custom-webview';

// params: any — the bridge payload is an untyped JSON object decoded from the WebView; each handler
// narrows it to its own param shape at the call site.
export type HandlerFn = (params: any) => unknown | Promise<unknown>;

interface RequestEnvelope {
  v: 1;
  id: string;
  kind: 'request';
  method: string;
  params?: unknown;
}

/**
 * AppWrap bridge — protocol v1 dispatcher.
 * Handlers are registered by method name ('haptics.impact'); requests arrive as
 * JSON strings, responses/events go back via `window.__appwrapDeliver(json)`.
 */
export class Bridge {
  private handlers = new Map<string, HandlerFn>();
  private webView: CustomWebView | null = null;

  register(method: string, handler: HandlerFn): void {
    this.handlers.set(method, handler);
  }

  /** Whether a handler is already registered for `method` (used by the plugin host to refuse a
   * namespaced key that would clobber a core handler). */
  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /**
   * Both platforms push envelopes in: iOS via WKScriptMessageHandler 'appwrap',
   * Android via the prompt() tunnel intercepted in WebChromeClient.onJsPrompt
   * (see custom-webview.android.ts) — no polling on either side.
   */
  attach(webView: CustomWebView): void {
    this.webView = webView;
    webView.onAppwrapMessage = (json) => this.onMessage(json);
  }

  detach(): void {
    if (this.webView) this.webView.onAppwrapMessage = null;
    this.webView = null;
  }

  /** The attached WebView (for handlers that drive it directly, e.g. app.reload). */
  getWebView(): CustomWebView | null {
    return this.webView;
  }

  emit(event: string, payload?: unknown): void {
    this.deliver(JSON.stringify({ v: 1, kind: 'event', event, payload }));
  }

  /** Response-delivery retry cadence. iOS THROTTLES/freezes the WebContent renderer for ~30-45s while
   * a native surface (permission alert, sheet, picker) sits over the WebView — `evaluateJavaScript`
   * simply never runs — so we keep re-offering the response until the renderer wakes. The window is
   * deliberately just under native-kit's 60s invoke watchdog: landing a real answer at 50s still beats
   * the bogus TIMEOUT, and past that the caller has already given up. Static so tests can shrink them. */
  static responseRetryMs = 2_000;
  static responseRetryWindowMs = 50_000;
  /** Per-ATTEMPT cap. A throttled WKWebView does not necessarily fail the eval — its completion
   * handler may simply never fire, leaving the promise pending forever. Without this, a frozen
   * renderer would silently stall the retry loop and we would be back to the 60s lie. */
  static responseAttemptTimeoutMs = 3_000;

  private async onMessage(json: string): Promise<void> {
    let req: RequestEnvelope;
    try {
      req = JSON.parse(json);
    } catch {
      console.error('Bridge: unparseable envelope', json?.slice(0, 200));
      return;
    }
    if (req.kind !== 'request' || !req.id || !req.method) return;

    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.respond(req.id, undefined, { code: 'UNSUPPORTED', message: `No handler for ${req.method}` });
      return;
    }
    try {
      const result = await handler(req.params ?? {});
      this.respond(req.id, result);
    } catch (e: any) {
      this.respond(req.id, undefined, { code: e?.code ?? 'NATIVE_ERROR', message: e?.message ?? String(e) });
    }
  }

  /**
   * A response is the ONLY thing that settles the caller's promise. native-kit arms a per-invoke
   * watchdog, so a response we fail to deliver does not surface as "delivery failed" — it surfaces to
   * the USER as a bogus `<method> timed out after 60000ms`, i.e. a permission state or a real native
   * error masquerading as a hang. That is exactly how geo.current's 15s `location timeout` became a
   * silent 60s lie: the CoreLocation prompt froze the renderer, this eval no-op'd, and the old
   * fire-and-forget `.catch(console.error)` swallowed it.
   *
   * So: retry until the renderer wakes, and if we truly give up, say so LOUDLY — never silently.
   * Retry is RESPONSE-ONLY and safe: the adapter drops an id it has already settled (handleResponse
   * `if (!p) return`), so a double-delivery is a no-op. Events are NOT idempotent → still one-shot.
   */
  private respond(id: string, result?: unknown, error?: { code: string; message: string }): void {
    const json = JSON.stringify({ v: 1, id, kind: 'response', result, error });
    void this.deliverResponse(json, id, error?.code);
  }

  private async deliverResponse(envelopeJson: string, id: string, code?: string): Promise<void> {
    const deadline = Date.now() + Bridge.responseRetryWindowMs;
    let attempt = 0;
    let lastErr: unknown;
    for (;;) {
      try {
        // Race the eval against a per-attempt cap: a frozen renderer may never call back at all.
        await Promise.race([
          this.deliverOnce(envelopeJson),
          new Promise((_r, rej) =>
            setTimeout(() => rej(new Error('eval did not complete (renderer throttled?)')),
              Bridge.responseAttemptTimeoutMs)),
        ]);
        if (attempt > 0) console.log(`Bridge: response ${id} delivered after ${attempt} retries`);
        return;
      } catch (e) {
        lastErr = e;
        attempt++;
        if (Date.now() + Bridge.responseRetryMs >= deadline) break;
        await new Promise((r) => setTimeout(r, Bridge.responseRetryMs));
      }
    }
    // Undeliverable. The caller WILL report a bogus timeout for this id — leave the real reason behind.
    console.error(
      `Bridge: response ${id}${code ? ` (${code})` : ''} UNDELIVERABLE after ${attempt} attempts ` +
        `— the caller will report a false TIMEOUT. Last error:`,
      lastErr
    );
  }

  private deliver(envelopeJson: string): void {
    this.deliverOnce(envelopeJson).catch((e) => console.error('Bridge: deliver failed', e));
  }

  private deliverOnce(envelopeJson: string): Promise<unknown> {
    const js = `window.__appwrapDeliver && window.__appwrapDeliver(${JSON.stringify(envelopeJson)})`;
    return this.evalJs(js);
  }

  /** Evaluate JS in the WebView and resolve its value (used by deliver + the dev-menu version probe). */
  evalJs(script: string): Promise<any> {
    const wv = this.webView;
    return new Promise((resolve, reject) => {
      if (!wv) return reject(new Error('no webview'));
      if (isIOS && wv.ios) {
        (wv.ios as WKWebView).evaluateJavaScriptCompletionHandler(script, (result, error) => {
          if (error) reject(new Error(error.localizedDescription));
          else resolve(result);
        });
      } else if (isAndroid && wv.android) {
        wv.android.evaluateJavascript(
          script,
          new android.webkit.ValueCallback({ onReceiveValue: (r: string) => resolve(r ? JSON.parse(r) : null) })
        );
      } else {
        reject(new Error('webview not ready'));
      }
    });
  }
}

export const bridge = new Bridge();
