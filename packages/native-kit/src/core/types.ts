export type Platform = 'ios' | 'android' | 'web';
export type AdapterKind = 'appwrap' | 'web';

/** Bridge protocol version this kit speaks. The native shell reports its own in the handshake;
 * `ready()` asserts they match so a kit running against a stale shell fails loud instead of
 * silently mis-degrading. Bump in lockstep with a breaking change to the wire envelope. */
export const KIT_PROTOCOL = 1 as const;

/** How a capability is fulfilled in the current environment. */
export type Capability = 'native' | 'web' | 'none';

export interface AppInfo {
  id: string;
  name: string;
  version: string;
  build?: string;
}

export interface Handshake {
  protocol: 1;
  platform: Platform;
  app: AppInfo;
  capabilities: Record<string, Capability>;
  /** Optional diagnostic payload (breadcrumbs, etc.). */
  debug?: Record<string, unknown>;
}

/** Wire envelope (appwrap protocol v1). Web adapter never serializes these. */
export interface RequestEnvelope {
  v: 1;
  id: string;
  kind: 'request';
  method: string;
  params?: unknown;
}

export interface ResponseEnvelope {
  v: 1;
  id: string;
  kind: 'response';
  result?: unknown;
  error?: { code: KitErrorCode; message: string };
}

export interface EventEnvelope {
  v: 1;
  kind: 'event';
  event: string;
  payload?: unknown;
}

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

export type KitErrorCode = 'UNSUPPORTED' | 'DENIED' | 'TIMEOUT' | 'NATIVE_ERROR' | 'NOT_READY';

export class KitError extends Error {
  constructor(public code: KitErrorCode, message: string) {
    super(message);
    this.name = 'KitError';
  }
}

export type Unsubscribe = () => void;

export interface InvokeOptions {
  /** Per-call response deadline. Interactive flows (pickers, dialogs, auth
   * prompts) should pass a generous one — the user may take their time. */
  timeoutMs?: number;
}

export interface NativeKitAdapter {
  readonly kind: AdapterKind;
  /** Is this environment present? Must be cheap and side-effect free. */
  detect(): boolean;
  handshake(timeoutMs: number): Promise<Handshake>;
  invoke<T = unknown>(method: string, params?: unknown, opts?: InvokeOptions): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): Unsubscribe;
}
