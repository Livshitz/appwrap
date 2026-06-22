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

  private respond(id: string, result?: unknown, error?: { code: string; message: string }): void {
    this.deliver(JSON.stringify({ v: 1, id, kind: 'response', result, error }));
  }

  private deliver(envelopeJson: string): void {
    const js = `window.__appwrapDeliver && window.__appwrapDeliver(${JSON.stringify(envelopeJson)})`;
    this.evalJs(js).catch((e) => console.error('Bridge: deliver failed', e));
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
