/**
 * appwrap plugin contract — the PORT (`@livx.cc/appwrap/plugin`).
 *
 * A TS plugin consumes a CURATED, VERSIONED facade over the native window primitives
 * ({@link WindowCtx}) — it never touches native FFI. The plugin runs OUT-OF-WEBVIEW in a trusted
 * multiplexed Bun host, which speaks a bidirectional line-JSON protocol to the native shell that
 * owns the primitives.
 *
 * IoC / Hollywood: the CORE calls the plugin — on window-created it fans out to each plugin whose
 * `attachTo` matches, invoking `onWindow(ctx)`. Plugins never reach into core internals.
 *
 * A plugin with ONLY `handlers` behaves exactly like today's `defineHandlers` sidecar (back-compat):
 * `desktop.handlers` is sugar for a local handlers-only plugin.
 */

/** The facade version this contract targets. Bump on a breaking WindowCtx change. */
export const WINDOW_CTX_VERSION = 1 as const;

/** Which windows a plugin attaches to (the OPT-IN gate — nothing is controllable unless configured).
 * String forms are also expressible in `appwrap.config.ts` (stamped into shell_config); the predicate
 * form is code-only (it lives in the host process). */
export type WindowScope =
  | 'main' // the app's main window
  | 'browser' // browser sub-windows (the controlled webview labeled `<win_id>-view`) — remote-control's default
  | 'all' // every window (incl. sub-windows)
  | string // an explicit window label / id
  | ((win: WindowIdentity) => boolean);

/** The minimal identity the host matches `attachTo` against. */
export interface WindowIdentity {
  id: string;
  /** Per-profile isolated store id, when the window was created for a profile; else undefined. */
  profileId?: string;
}

/** Disposer returned by subscriptions / `onWindow` for teardown on detach/close. */
export type Dispose = () => void;

/**
 * Curated, versioned facade over the native window primitives, scoped to ONE window.
 * NOT raw FFI — a deliberately small subset (design risk #4: avoid a god-interface). Every method
 * marshals over the host↔shell socket as an `op` envelope and awaits a `result`.
 */
export interface WindowCtx extends WindowIdentity {
  /** Current top-level URL of the window. */
  url(): Promise<string>;
  /** Inject JS that runs immediately in the page (fire-and-forget; no return value). */
  injectScript(js: string): Promise<void>;
  /** CSP-immune eval with an awaited return value (callAsyncJavaScript). `js` is a FUNCTION BODY
   * (use `return`). Result is JSON-parsed. */
  eval<T = unknown>(js: string): Promise<T>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  /** PNG bytes of the current page. */
  snapshot(): Promise<Uint8Array>;
  close(): Promise<void>;
  /** Toggle the Safari Web Inspector for this window (release builds gate on APPWRAP_DEVTOOLS). */
  setInspectable(on: boolean): Promise<void>;
  /** Subscribe to page→plugin beacons: the page calls
   * `webkit.messageHandlers.bridgeShim.postMessage(json)`; `cb` receives the RAW string. */
  onMessage(cb: (msg: string) => void): Dispose;
  /** plugin→page: delivered as a `window` `appwrap:plugin` CustomEvent whose `detail` is `msg`. */
  postMessage(msg: unknown): Promise<void>;
}

/** The plugin definition — authored with {@link definePlugin} and `export default`ed. */
export interface PluginDef {
  /** Namespace — guards against shadowing built-in method prefixes (like the sidecar's filter). */
  name: string;
  /** BACK-COMPAT: PWA→plugin RPC, identical semantics to `defineHandlers`. */
  handlers?: Record<string, (params: any) => any | Promise<any>>;
  /** OPT-IN: which windows this plugin attaches to. Omit → no per-window attach (handlers-only). */
  attachTo?: WindowScope;
  /** Per-window attach hook (the bidirectional part). Return a Dispose for detach cleanup. */
  onWindow?(win: WindowCtx): void | Dispose | Promise<void | Dispose>;
  /** Window closed. */
  onClose?(win: WindowIdentity): void;
}

// ── Wire protocol (host ↔ shell, one JSON object per line) ────────────────────────────────────────
// Envelope: { pluginId?, windowId?, kind, method?, params?, id?, ... }. Route by pluginId × windowId.
//   host → shell:  { kind:'ready',  plugins:[{ pluginId, methods:[…] }] }   (once, at boot)
//   host → shell:  { kind:'op',     id, pluginId, windowId, method, params }  (a WindowCtx call)
//   shell → host:  { kind:'result', id, ok, data|error }                     (op result)
//   shell → host:  { kind:'event',  method, windowId, params }               (window/page lifecycle)
//   shell → host:  { kind:'call',   id, method, params }                     (handler RPC, ==sidecar)
//   host → shell:  { kind:'result', id, ok, data|error }                     (handler result)
// `result` is bidirectional — each side keys its own pending map by the unique `id` it minted.

export type Envelope =
  | { kind: 'ready'; plugins: { pluginId: string; methods: string[] }[] }
  | { kind: 'op'; id: string; pluginId: string; windowId: string; method: string; params?: unknown }
  | { kind: 'result'; id: string; ok: boolean; data?: unknown; error?: { code: string; message: string } }
  | { kind: 'event'; method: 'window-created' | 'window-closed' | 'message'; windowId: string; params?: any }
  | { kind: 'call'; id: string; method: string; params?: unknown };

/** One resolved plugin the host loads at boot (stamped into shell_config by `regeneratePlugins`). */
export interface StampedPlugin {
  /** Bundle/build id derived from the config source (sanitized filename or package name). This is a
   * pre-bundle-load stamp — the plugin's real def `name` isn't known until the host `import()`s the
   * bundle. It is NOT the routing/diagnostic identifier: routing (matchScope, registry) and all
   * diagnostics key off the loaded def `name`. Used only for the bundle filename. */
  bundleId: string;
  /** Config-level attachTo OVERRIDE (string forms only). Falls back to the def's own `attachTo`. */
  attachTo?: 'main' | 'all' | string;
  /** Absolute path to the bun-built single-file plugin bundle. */
  bundlePath: string;
}
