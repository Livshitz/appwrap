import {
  Envelope,
  Handshake,
  InvokeOptions,
  KitError,
  NativeKitAdapter,
  RequestEnvelope,
  ResponseEnvelope,
  Unsubscribe,
} from './types';

declare global {
  interface Window {
    webkit?: { messageHandlers?: { appwrap?: { postMessage(msg: unknown): void } } };
    appwrapNative?: { postMessage(json: string): void };
    __appwrapDeliver?: (json: string) => void;
  }
}

/**
 * Talks appwrap protocol v1 to the native shell. Envelopes travel as JSON strings
 * in both directions (NSDictionary marshalling through WKScriptMessage is lossy in
 * some bridges; strings are not).
 * - web → native: iOS `webkit.messageHandlers.appwrap.postMessage(json)`,
 *   Android `appwrapNative.postMessage(json)` (shell-injected shim or JS interface).
 * - native → web: shell evaluates `window.__appwrapDeliver(json)`.
 */
export class AppwrapAdapter implements NativeKitAdapter {
  readonly kind = 'appwrap' as const;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private seq = 0;

  detect(): boolean {
    return typeof window !== 'undefined' &&
      (!!window.webkit?.messageHandlers?.appwrap || !!window.appwrapNative);
  }

  async handshake(timeoutMs: number): Promise<Handshake> {
    this.installDeliver();
    return this.request<Handshake>('app.handshake', undefined, timeoutMs);
  }

  invoke<T>(method: string, params?: unknown, opts?: InvokeOptions): Promise<T> {
    return this.request<T>(method, params, opts?.timeoutMs ?? 10_000);
  }

  /** `'none'` or `0` → no watchdog (dismiss-bound calls); otherwise the deadline in ms. */
  private static resolveTimeout(timeoutMs: number | 'none'): number | null {
    if (timeoutMs === 'none' || timeoutMs === 0) return null;
    return timeoutMs;
  }

  on(event: string, cb: (payload: unknown) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  private request<T>(method: string, params: unknown, timeoutMs: number | 'none'): Promise<T> {
    const id = `k${++this.seq}`;
    const envelope: RequestEnvelope = { v: 1, id, kind: 'request', method, params };
    const deadline = AppwrapAdapter.resolveTimeout(timeoutMs);
    return new Promise<T>((resolve, reject) => {
      // `null` deadline = dismiss-bound call: no watchdog, resolves only on the
      // native response (e.g. the user closes the sheet).
      const timer = deadline === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new KitError('TIMEOUT', `${method} timed out after ${deadline}ms`));
      }, deadline);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.post(envelope);
    });
  }

  private post(envelope: RequestEnvelope): void {
    const json = JSON.stringify(envelope);
    if (window.webkit?.messageHandlers?.appwrap) {
      window.webkit.messageHandlers.appwrap.postMessage(json);
    } else if (window.appwrapNative) {
      window.appwrapNative.postMessage(json);
    } else {
      const p = this.pending.get(envelope.id);
      this.pending.delete(envelope.id);
      p?.reject(new KitError('NOT_READY', 'No native transport present'));
    }
  }

  private installDeliver(): void {
    if (window.__appwrapDeliver) return;
    window.__appwrapDeliver = (json: string) => {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(json);
      } catch {
        return;
      }
      if (envelope.kind === 'response') this.handleResponse(envelope);
      else if (envelope.kind === 'event') {
        this.listeners.get(envelope.event)?.forEach((cb) => cb(envelope.payload));
      }
    };
  }

  private handleResponse(envelope: ResponseEnvelope): void {
    const p = this.pending.get(envelope.id);
    if (!p) return;
    this.pending.delete(envelope.id);
    if (envelope.error) p.reject(new KitError(envelope.error.code, envelope.error.message));
    else p.resolve(envelope.result);
  }
}
