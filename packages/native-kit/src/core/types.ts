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
  /** How the shell loads content: 'app'/'file' (bundled) or 'server' (remote URL). Drives
   * remote-update detection (only meaningful for 'server'). Absent on web/older shells. */
  loader?: 'app' | 'file' | 'server';
}

export interface Handshake {
  protocol: 1;
  platform: Platform;
  app: AppInfo;
  capabilities: Record<string, Capability>;
  /** Set ONLY on a background launch: the OS woke the app (possibly cold, headless, no visible
   * WebView) to run this registered background-task id. The shell populates it; `kit.backgroundTask`
   * reads it from {@link NativeKit.handshakeInfo} and dispatches the registered handler. Absent on a
   * normal foreground launch. See {@link BackgroundTaskModule}. */
  backgroundTaskId?: string;
  /** Set ONLY on a cold launch FROM a deep link (url-scheme open or notification tap that started the
   * app): the link that launched us, handed back synchronously so the PWA can route to the target
   * route BEFORE first paint — avoiding a brief home-screen flash. A WARM deep link (app already
   * running) is NOT carried here; it arrives via the `deeplink.open` event. Read it at `ready()` via
   * {@link LifecycleModule.launchDeepLink}. Absent on a normal launch. */
  deepLink?: string;
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
  /** Per-call response deadline (default 10_000ms).
   *
   * Interactive flows (pickers, dialogs, auth prompts) should pass a generous
   * value — the user may take their time.
   *
   * Pass `'none'` (or `0`) to DISABLE the watchdog entirely. Use this ONLY for
   * dismiss-bound / present-and-wait calls: native UI that resolves solely when
   * the user dismisses a sheet/modal (manage-subscriptions sheet,
   * ASWebAuthenticationSession, share sheet, …). For these there is no
   * meaningful deadline — a watchdog could only false-timeout mid-interaction
   * and force a spurious fallback. Do NOT use it for fire-and-fast calls: a
   * finite timeout is what surfaces a real native hang. */
  timeoutMs?: number | 'none';
}

export interface NativeKitAdapter {
  readonly kind: AdapterKind;
  /** Is this environment present? Must be cheap and side-effect free. */
  detect(): boolean;
  handshake(timeoutMs: number): Promise<Handshake>;
  invoke<T = unknown>(method: string, params?: unknown, opts?: InvokeOptions): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): Unsubscribe;
}
