import { AppwrapAdapter } from './appwrap-adapter';
import { WebAdapter } from './web-adapter';
import { ModuleRegistry } from './module-registry';
import type { KitModuleRegistry } from './module-registry';
import { Capability, Handshake, InvokeOptions, KIT_PROTOCOL, KitError, NativeKitAdapter, Platform, Unsubscribe } from './types';
import { AppModule } from '../modules/app';
import { AppleSignInModule } from '../modules/appleSignIn';
import { ShareTargetModule } from '../modules/shareTarget';
import { BackgroundTaskModule } from '../modules/backgroundTask';
import { BiometricsModule } from '../modules/biometrics';
import { BrowserModule } from '../modules/browser';
import { CalendarModule } from '../modules/calendar';
import { ClipboardModule } from '../modules/clipboard';
import { ContactsModule } from '../modules/contacts';
import { DeviceModule } from '../modules/device';
import { FsModule } from '../modules/fs';
import { GeoModule } from '../modules/geo';
import { HeadingModule } from '../modules/heading';
import { HapticsModule } from '../modules/haptics';
import { KeyboardModule } from '../modules/keyboard';
import { LifecycleModule } from '../modules/lifecycle';
import { MediaModule } from '../modules/media';
import { MotionModule } from '../modules/motion';
import { NetworkModule } from '../modules/network';
import { NotificationsModule } from '../modules/notifications';
import { OAuthModule } from '../modules/oauth';
import { PhotosModule } from '../modules/photos';
import { PushModule } from '../modules/push';
import { ReviewsModule } from '../modules/reviews';
import { ScannerModule } from '../modules/scanner';
import { ScreenModule } from '../modules/screen';
import { ShareModule } from '../modules/share';
import { SpeechModule } from '../modules/speech';
import { StorageModule } from '../modules/storage';
import { ToastModule } from '../modules/toast';
import { TrackingModule } from '../modules/tracking';
import { UiModule } from '../modules/ui';
import { UpdatesModule } from '../modules/updates';

export class NativeKitOptions {
  /** Priority order; first adapter whose detect() passes wins. */
  adapters: NativeKitAdapter[] = [new AppwrapAdapter(), new WebAdapter()];
  handshakeTimeoutMs = 3000;
}

/**
 * Flat, vendor-neutral analytics bag — spread straight into your analytics provider's
 * super-properties (e.g. `mixpanel.register(await kit.context())`). Native-only fields
 * degrade gracefully (omitted/undefined) on web and on older shells. snake_case keys
 * match common analytics conventions.
 */
export interface KitContext {
  /** Coarse runtime taxonomy: 'native-ios' | 'native-android' | 'web'. */
  client: string;
  is_native: boolean;
  platform: Platform;
  app_id?: string;
  app_name?: string;
  app_version?: string;
  app_build?: string;
  /** App Store / TestFlight / sideload / simulator / web. */
  install_source?: string;
  /** Stable per-install id (iOS IDFV / Android UUID) — first-party, non-tracking. */
  install_id?: string;
  first_install_at?: number;
  last_update_at?: number;
  is_emulator?: boolean;
  device_model?: string;
  device_os?: string;
  device_os_version?: string;
  device_manufacturer?: string;
  device_language?: string;
  device_region?: string;
  push_permission?: string;
  network_type?: string;
}

export class NativeKit {
  public readonly haptics = new HapticsModule(this);
  public readonly share = new ShareModule(this);
  public readonly screen = new ScreenModule(this);
  public readonly keyboard = new KeyboardModule(this);
  public readonly storage = new StorageModule(this);
  public readonly fs = new FsModule(this);
  public readonly toast = new ToastModule(this);
  public readonly ui = new UiModule(this);
  public readonly device = new DeviceModule(this);
  public readonly clipboard = new ClipboardModule(this);
  public readonly notifications = new NotificationsModule(this);
  public readonly push = new PushModule(this);
  public readonly biometrics = new BiometricsModule(this);
  public readonly geo = new GeoModule(this);
  public readonly heading = new HeadingModule(this);
  public readonly photos = new PhotosModule(this);
  public readonly network = new NetworkModule(this);
  public readonly lifecycle = new LifecycleModule(this);
  public readonly reviews = new ReviewsModule(this);
  public readonly motion = new MotionModule(this);
  public readonly media = new MediaModule(this);
  public readonly contacts = new ContactsModule(this);
  public readonly scanner = new ScannerModule(this);
  public readonly speech = new SpeechModule(this);
  public readonly calendar = new CalendarModule(this);
  public readonly app = new AppModule(this);
  public readonly browser = new BrowserModule(this);
  public readonly oauth = new OAuthModule(this);
  public readonly updates = new UpdatesModule(this);
  public readonly backgroundTask = new BackgroundTaskModule(this);
  public readonly tracking = new TrackingModule(this);
  public readonly appleSignIn = new AppleSignInModule(this);
  public readonly shareTarget = new ShareTargetModule(this);

  /**
   * Additive, string-keyed registry mirroring the eager fields above (SAME instances) — a new
   * capability-access path out-of-repo module packs register into (e.g. the billing/health/widget
   * out-of-tree packs call `kit.modules.registerModule(...)`). For core modules `kit.getModule('haptics')
   * === kit.haptics`. Fails loud on miss.
   */
  public readonly modules = new ModuleRegistry();

  public handshakeInfo: Handshake | null = null;
  public options: NativeKitOptions;
  private adapter: NativeKitAdapter | null = null;
  /** Web-platform fallback behind a native shell: methods the shell rejects as UNSUPPORTED
   * are retried against the WebAdapter, so a capability the webview itself can satisfy
   * (geolocation, speech, navigator.share, …) works even when the shell ships no handler
   * for it. Capability keys the shell reports as 'none'/absent surface as 'web' when the
   * fallback can fulfil them. */
  private webFallback: NativeKitAdapter | null = null;
  /**
   * Method-name prefixes the web fallback must NEVER be retried against. Empty by default;
   * a module pack declares its own policy via {@link excludeWebFallback} at registration.
   * e.g. the billing pack excludes `billing.` — purchases inside a native shell belong to the
   * device store, and retrying them on the WebAdapter would replace the shell's real, actionable
   * error with a false "use a web checkout" one (App Store Guideline 3.1.1 territory).
   */
  private webFallbackExcludedDomains = new Set<string>();
  private readyPromise: Promise<Handshake> | null = null;
  private contextPromise: Promise<KitContext> | null = null;

  constructor(options?: Partial<NativeKitOptions>) {
    this.options = { ...new NativeKitOptions(), ...options };
    // Mirror the eager CORE fields into the string-keyed registry (same instances, no behaviour
    // change). Typed as a plain string map — not `Record<keyof KitModuleRegistry, unknown>` — because
    // out-of-repo packs augment KitModuleRegistry with keys the core never mounts (billing/health/widget);
    // those are registered by the pack's register<Name>Kit(), not here.
    const eager: Record<string, unknown> = {
      haptics: this.haptics, share: this.share, screen: this.screen, keyboard: this.keyboard,
      storage: this.storage, fs: this.fs, toast: this.toast, ui: this.ui, device: this.device,
      clipboard: this.clipboard, notifications: this.notifications, push: this.push,
      biometrics: this.biometrics, geo: this.geo, heading: this.heading, photos: this.photos,
      network: this.network, lifecycle: this.lifecycle, reviews: this.reviews, motion: this.motion,
      media: this.media, contacts: this.contacts, scanner: this.scanner,
      speech: this.speech, calendar: this.calendar, app: this.app, browser: this.browser,
      oauth: this.oauth, updates: this.updates,
      backgroundTask: this.backgroundTask, tracking: this.tracking, appleSignIn: this.appleSignIn,
      shareTarget: this.shareTarget,
    };
    for (const [name, inst] of Object.entries(eager)) this.modules.registerModule(name, inst);
  }

  /** Typed, string-keyed module lookup — delegates to {@link ModuleRegistry.getModule}.
   * Throws (listing mounted modules) if the name isn't registered. */
  getModule<K extends keyof KitModuleRegistry>(name: K): KitModuleRegistry[K] {
    return this.modules.getModule(name);
  }

  /** Declare a method-name prefix the web fallback must never retry against (see
   * {@link webFallbackExcludedDomains}). Module packs call this at registration to own their
   * own policy — e.g. the billing pack excludes `billing.`. Idempotent. */
  excludeWebFallback(prefix: string): void {
    this.webFallbackExcludedDomains.add(prefix);
  }

  /** Resolve the environment and perform the handshake. Idempotent. */
  ready(): Promise<Handshake> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const candidates = this.options.adapters.filter((a) => a.detect());
        if (!candidates.length) throw new KitError('NOT_READY', 'No adapter detected this environment');
        // Try each detected adapter in priority order. A transport can LOOK native yet refuse
        // the handshake — e.g. a host shell exposing a capability-GATED `appwrap` message
        // handler to an embedded/mini-app page (CAP_DENIED, or no handshake handler at all).
        // Falling through to the next adapter (web) lets the app degrade to standard web
        // APIs instead of dying with no transport at all.
        let handshake: Handshake | null = null;
        let lastError: unknown = null;
        for (const adapter of candidates) {
          try {
            handshake = await adapter.handshake(this.options.handshakeTimeoutMs);
            this.adapter = adapter;
            break;
          } catch (e) {
            lastError = e;
            console.warn(`[native-kit] ${adapter.kind} adapter handshake failed (${(e as Error)?.message ?? e}) — trying next adapter`);
          }
        }
        if (!handshake) throw lastError ?? new KitError('NOT_READY', 'All adapters failed the handshake');
        // Version-skew safety net: a native shell from an older `appwrap init` may speak a
        // different protocol. Fail loud rather than silently mis-degrade. The web adapter
        // always reports the kit's own protocol, so this only ever fires against a stale shell.
        if (handshake.protocol !== KIT_PROTOCOL) {
          throw new KitError(
            'UNSUPPORTED',
            `Shell protocol v${handshake.protocol} ≠ kit protocol v${KIT_PROTOCOL} — ` +
              `the native wrapper is out of date. Re-run \`appwrap init\` to regenerate it.`
          );
        }
        this.handshakeInfo = handshake;
        // Hybrid degrade: pair a native shell with the web adapter for anything the shell
        // doesn't implement. WebAdapter.handshake() is pure feature detection (no side
        // effects), so probing it here is safe.
        if (this.adapter!.kind !== 'web') {
          const web = this.options.adapters.find((a) => a.kind === 'web');
          if (web?.detect()) {
            try {
              const webHs = await web.handshake(this.options.handshakeTimeoutMs);
              this.webFallback = web;
              for (const [key, value] of Object.entries(webHs.capabilities)) {
                // Only ABSENT keys are upgraded. An explicit 'none' from the shell is a
                // veto — it means "this platform genuinely can't", not "no handler" (e.g.
                // desktop reports motion:'none': DeviceMotionEvent exists in the webview
                // but never fires without an accelerometer, so 'web' would be a lie).
                if (handshake.capabilities[key] === undefined && value !== 'none') {
                  handshake.capabilities[key] = 'web';
                }
              }
            } catch (e) {
              console.warn('[native-kit] web fallback probe failed', e);
            }
          }
        }
        // Zero-config: a native server-loader app begins polling for remote updates.
        this.updates.__autostart();
        // A background launch carries the wake id in the handshake → dispatch the registered handler
        // (the app's boot register() may have already run, or land moments later — both dispatch).
        this.backgroundTask.__onReady(handshake.backgroundTaskId);
        return this.handshakeInfo;
      })();
    }
    return this.readyPromise;
  }

  /**
   * One flat analytics bag (handshake + device + install env + push perm + network),
   * ready to spread into super-properties. Resilient: each native probe degrades to
   * omitted on failure, so this never rejects once {@link ready} resolves. Cached.
   */
  context(): Promise<KitContext> {
    if (!this.contextPromise) {
      this.contextPromise = (async () => {
        await this.ready();
        const hs = this.handshakeInfo!;
        const client = this.is.native ? `native-${hs.platform}` : 'web';
        const ctx: KitContext = {
          client,
          is_native: this.is.native,
          platform: hs.platform,
          app_id: hs.app?.id,
          app_name: hs.app?.name,
          app_version: hs.app?.version,
          app_build: hs.app?.build,
        };
        // Probe in parallel; a failing/absent capability simply leaves its fields unset.
        const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
        const [env, device, push, net] = await Promise.all([
          safe(this.app.environment()),
          safe(this.device.info()),
          this.push.capability === 'native' ? safe(this.push.permissionStatus()) : Promise.resolve(null),
          safe(this.network.status()),
        ]);
        if (env) {
          ctx.install_source = env.source;
          ctx.install_id = env.installId;
          ctx.first_install_at = env.firstInstallAt;
          ctx.last_update_at = env.lastUpdateAt;
          ctx.is_emulator = env.isEmulator;
        }
        if (device) {
          ctx.device_model = device.model;
          ctx.device_os = device.os;
          ctx.device_os_version = device.osVersion;
          ctx.device_manufacturer = device.manufacturer;
          ctx.device_language = device.language;
          ctx.device_region = device.region;
        }
        if (push) ctx.push_permission = push;
        if (net) ctx.network_type = net.type;
        return ctx;
      })();
    }
    return this.contextPromise;
  }

  get is() {
    return { native: this.adapter?.kind === 'appwrap', web: this.adapter?.kind === 'web' };
  }

  get platform() {
    return this.handshakeInfo?.platform ?? 'web';
  }

  capability(name: string): Capability {
    return this.handshakeInfo?.capabilities[name] ?? 'none';
  }

  async invoke<T = unknown>(method: string, params?: unknown, opts?: InvokeOptions): Promise<T> {
    if (!this.adapter) await this.ready();
    try {
      return await this.adapter!.invoke<T>(method, params, opts);
    } catch (e) {
      if (
        this.webFallback &&
        e instanceof KitError &&
        e.code === 'UNSUPPORTED' &&
        ![...this.webFallbackExcludedDomains].some((d) => method.startsWith(d))
      ) {
        return this.webFallback.invoke<T>(method, params, opts);
      }
      throw e;
    }
  }

  on(event: string, cb: (payload: unknown) => void): Unsubscribe {
    if (!this.adapter) {
      // Defer subscription until ready() resolves the adapter.
      let unsub: Unsubscribe | null = null;
      let cancelled = false;
      this.ready()
        .then(() => {
          if (!cancelled) unsub = this.subscribe(event, cb);
        })
        .catch(() => {}); // ready() failure already surfaces to the ready() caller
      return () => { cancelled = true; unsub?.(); };
    }
    return this.subscribe(event, cb);
  }

  /** Listen on the active adapter AND the web fallback — a watch that fell back to the
   * WebAdapter (geo.position, motion.data) emits its events there, not on the shell. */
  private subscribe(event: string, cb: (payload: unknown) => void): Unsubscribe {
    const unsubs = [this.adapter!.on(event, cb)];
    if (this.webFallback) unsubs.push(this.webFallback.on(event, cb));
    return () => unsubs.forEach((u) => u());
  }
}

/** Typed registry map — augment via declaration merging so `getModule(name)` returns the
 * strongly-typed module. Out-of-repo packs augment this same interface to add their own. */
declare module './module-registry' {
  interface KitModuleRegistry {
    haptics: HapticsModule;
    share: ShareModule;
    screen: ScreenModule;
    keyboard: KeyboardModule;
    storage: StorageModule;
    fs: FsModule;
    toast: ToastModule;
    ui: UiModule;
    device: DeviceModule;
    clipboard: ClipboardModule;
    notifications: NotificationsModule;
    push: PushModule;
    biometrics: BiometricsModule;
    geo: GeoModule;
    heading: HeadingModule;
    photos: PhotosModule;
    network: NetworkModule;
    lifecycle: LifecycleModule;
    reviews: ReviewsModule;
    motion: MotionModule;
    media: MediaModule;
    contacts: ContactsModule;
    scanner: ScannerModule;
    speech: SpeechModule;
    calendar: CalendarModule;
    app: AppModule;
    browser: BrowserModule;
    oauth: OAuthModule;
    updates: UpdatesModule;
    backgroundTask: BackgroundTaskModule;
    tracking: TrackingModule;
    appleSignIn: AppleSignInModule;
    shareTarget: ShareTargetModule;
  }
}

/** Shared default instance — `import { kit } from '@livx.cc/native-kit'`. */
export const kit = new NativeKit();
