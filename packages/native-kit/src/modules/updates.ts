import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

export interface UpdateStatus {
  /** Version the running bundle BOOTED with (embedded), or '' if it couldn't be determined. */
  current: string;
  /** Version advertised by the live manifest, or '' if the fetch failed. */
  latest: string;
  /** Optional build identifier from the manifest. */
  build?: string | number;
  /** True only when both versions are known AND differ — never on an unknown `current`. */
  updateAvailable: boolean;
}

export interface UpdatesOptions {
  /** Version-manifest URL — a tiny JSON `{ version: string, build?: string|number }`.
   * Default: `${location.origin}/version.json`. */
  manifestUrl?: string;
  /** Poll cadence (ms). Always also checks on app resume. 0 = resume-only. Default 60_000. */
  pollIntervalMs?: number;
  /** Version the running bundle booted with. Default: `window.__APP_VERSION__` →
   * `<meta name="app-version">`. Supplying the bundle's OWN embedded version is what
   * makes the prompt trustworthy (see class doc). */
  currentVersion?: string;
  /** Auto-show a persistent native "tap to reload" banner when an update is detected. Default true. */
  autoPrompt?: boolean;
}

/**
 * Remote-update detection for `loader:'server'` apps.
 *
 * Polls a version manifest and compares it to the version the running bundle **booted with**
 * (its embedded `__APP_VERSION__`), NOT to a previous manifest read. That distinction is the
 * whole point: comparing manifest-to-manifest gives a phantom "update available" the moment a
 * deploy bumps the manifest but ships the old bundle (a real bug we've hit). Embedded-vs-manifest
 * only fires when the bytes actually running are behind the deploy.
 *
 * Auto-starts for server-loader native apps (zero app code); apps can also drive it manually via
 * {@link check}/{@link onAvailable}/{@link reload} or re-{@link start} with their own options.
 */
export class UpdatesModule {
  private started = false;
  private opts: Required<UpdatesOptions> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: Unsubscribe[] = [];
  private listeners = new Set<(s: UpdateStatus) => void>();
  /** The auto banner is shown at most once per JS session — so a dismissed prompt doesn't nag on
   * every poll. A reload (the intended response) boots a fresh bundle/context and resets this; until
   * then, {@link onAvailable} listeners still fire each check so an app can re-surface it itself. */
  private prompted = false;

  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('updates');
  }

  /** Fetch the manifest and compare to the boot version. Reports the result up to the shell
   * (for the dev-menu App Info screen) and fires {@link onAvailable} listeners on a fresh update. */
  async check(): Promise<UpdateStatus> {
    const o = this.opts ?? this.resolveOptions();
    const current = o.currentVersion;
    let latest = '';
    let build: string | number | undefined;
    try {
      // `no-store` skips the HTTP cache — but a cache-first service worker would still intercept and
      // serve a stale manifest, so the SW recipe must let `version.json` pass through to the network.
      const res = await fetch(o.manifestUrl, { cache: 'no-store' });
      if (res.ok) {
        const j = (await res.json()) as { version?: string; build?: string | number };
        latest = String(j?.version ?? '');
        build = j?.build;
      }
    } catch (e) {
      // Offline or no manifest deployed — not fatal; log and report "unknown latest".
      console.warn('[updates] manifest fetch failed:', (e as Error)?.message ?? e);
    }
    const updateAvailable = !!current && !!latest && current !== latest;
    const status: UpdateStatus = { current, latest, build, updateAvailable };

    // Surface to native so the shake → App Info screen can show "got the latest?".
    this.kit.invoke('app.reportWebVersion', status).catch((e) =>
      console.warn('[updates] reportWebVersion failed:', (e as Error)?.message ?? e)
    );

    if (updateAvailable) {
      this.listeners.forEach((cb) => cb(status));
      if (o.autoPrompt && !this.prompted) {
        this.prompted = true;
        this.kit
          .invoke('toast.banner', { id: 'appwrap.update', message: 'New version available — tap to reload' })
          .catch((e) => console.warn('[updates] banner failed:', (e as Error)?.message ?? e));
      }
    }
    return status;
  }

  /** Notify whenever a manifest check finds the running bundle is behind. */
  onAvailable(cb: (s: UpdateStatus) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Hard reload the WebView, bypassing cache (iOS `reloadFromOrigin`, Android cache-clear + reload). */
  reload(): Promise<void> {
    return this.kit.invoke('app.reload');
  }

  /** Begin polling + resume/banner wiring. Idempotent; re-calling replaces options. */
  start(options?: UpdatesOptions): void {
    this.opts = this.resolveOptions(options);
    if (this.started) {
      this.stop(/* keepStarted */ true);
    }
    this.started = true;
    // Re-check whenever the app returns to the foreground (catches a deploy made while backgrounded).
    this.unsubs.push(this.kit.on('app.resume', () => void this.check()));
    // Banner tap (or any 'appwrap.update' action) → reload.
    this.unsubs.push(
      this.kit.on('toast.action', (p) => {
        if ((p as { id?: string })?.id === 'appwrap.update') void this.reload();
      })
    );
    if (this.opts.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.check(), this.opts.pollIntervalMs);
    }
    void this.check();
  }

  stop(keepStarted = false): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (!keepStarted) this.started = false;
  }

  /** Called by NativeKit.ready() — self-starts only for a native server-loader app. */
  __autostart(): void {
    if (this.started) return;
    if (this.kit.is.native && this.kit.handshakeInfo?.app?.loader === 'server') this.start();
  }

  private resolveOptions(o?: UpdatesOptions): Required<UpdatesOptions> {
    const origin = typeof location !== 'undefined' ? location.origin : '';
    return {
      manifestUrl: o?.manifestUrl ?? `${origin}/version.json`,
      pollIntervalMs: o?.pollIntervalMs ?? 60_000,
      currentVersion: o?.currentVersion ?? bootVersion(),
      autoPrompt: o?.autoPrompt ?? true,
    };
  }
}

/** Embedded version the running bundle shipped with: `window.__APP_VERSION__`, then a
 * `<meta name="app-version">` tag. '' (unknown) when neither is present — in which case we never
 * raise a false update prompt. */
function bootVersion(): string {
  const g = typeof window !== 'undefined' ? (window as { __APP_VERSION__?: string }).__APP_VERSION__ : undefined;
  if (g) return String(g);
  if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="app-version"]');
    const c = meta?.getAttribute('content');
    if (c) return c;
  }
  return '';
}
