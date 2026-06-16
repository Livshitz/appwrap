import { AppwrapAdapter } from './appwrap-adapter';
import { WebAdapter } from './web-adapter';
import { Capability, Handshake, InvokeOptions, KIT_PROTOCOL, KitError, NativeKitAdapter, Unsubscribe } from './types';
import { AppModule } from '../modules/app';
import { BillingModule } from '../modules/billing/billing';
import { BiometricsModule } from '../modules/biometrics';
import { BrowserModule } from '../modules/browser';
import { CalendarModule } from '../modules/calendar';
import { ClipboardModule } from '../modules/clipboard';
import { ContactsModule } from '../modules/contacts';
import { DeviceModule } from '../modules/device';
import { GeoModule } from '../modules/geo';
import { HapticsModule } from '../modules/haptics';
import { HealthModule } from '../modules/health';
import { LifecycleModule } from '../modules/lifecycle';
import { MediaModule } from '../modules/media';
import { MotionModule } from '../modules/motion';
import { NetworkModule } from '../modules/network';
import { NotificationsModule } from '../modules/notifications';
import { OAuthModule } from '../modules/oauth';
import { PhotosModule } from '../modules/photos';
import { PushModule } from '../modules/push';
import { ReviewsModule } from '../modules/reviews';
import { ScreenModule } from '../modules/screen';
import { ShareModule } from '../modules/share';
import { StorageModule } from '../modules/storage';
import { ToastModule } from '../modules/toast';
import { UiModule } from '../modules/ui';

export class NativeKitOptions {
  /** Priority order; first adapter whose detect() passes wins. */
  adapters: NativeKitAdapter[] = [new AppwrapAdapter(), new WebAdapter()];
  handshakeTimeoutMs = 3000;
}

export class NativeKit {
  public readonly haptics = new HapticsModule(this);
  public readonly share = new ShareModule(this);
  public readonly screen = new ScreenModule(this);
  public readonly storage = new StorageModule(this);
  public readonly toast = new ToastModule(this);
  public readonly ui = new UiModule(this);
  public readonly device = new DeviceModule(this);
  public readonly clipboard = new ClipboardModule(this);
  public readonly notifications = new NotificationsModule(this);
  public readonly push = new PushModule(this);
  public readonly biometrics = new BiometricsModule(this);
  public readonly geo = new GeoModule(this);
  public readonly photos = new PhotosModule(this);
  public readonly network = new NetworkModule(this);
  public readonly lifecycle = new LifecycleModule(this);
  public readonly reviews = new ReviewsModule(this);
  public readonly motion = new MotionModule(this);
  public readonly health = new HealthModule(this);
  public readonly media = new MediaModule(this);
  public readonly contacts = new ContactsModule(this);
  public readonly calendar = new CalendarModule(this);
  public readonly app = new AppModule(this);
  public readonly browser = new BrowserModule(this);
  public readonly oauth = new OAuthModule(this);
  public readonly billing = new BillingModule(this);

  public handshakeInfo: Handshake | null = null;
  public options: NativeKitOptions;
  private adapter: NativeKitAdapter | null = null;
  private readyPromise: Promise<Handshake> | null = null;

  constructor(options?: Partial<NativeKitOptions>) {
    this.options = { ...new NativeKitOptions(), ...options };
  }

  /** Resolve the environment and perform the handshake. Idempotent. */
  ready(): Promise<Handshake> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const adapter = this.options.adapters.find((a) => a.detect());
        if (!adapter) throw new KitError('NOT_READY', 'No adapter detected this environment');
        this.adapter = adapter;
        const handshake = await adapter.handshake(this.options.handshakeTimeoutMs);
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
        return this.handshakeInfo;
      })();
    }
    return this.readyPromise;
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
    return this.adapter!.invoke<T>(method, params, opts);
  }

  on(event: string, cb: (payload: unknown) => void): Unsubscribe {
    if (!this.adapter) {
      // Defer subscription until ready() resolves the adapter.
      let unsub: Unsubscribe | null = null;
      let cancelled = false;
      this.ready()
        .then(() => {
          if (!cancelled) unsub = this.adapter!.on(event, cb);
        })
        .catch(() => {}); // ready() failure already surfaces to the ready() caller
      return () => { cancelled = true; unsub?.(); };
    }
    return this.adapter.on(event, cb);
  }
}

/** Shared default instance — `import { kit } from '@livx.cc/native-kit'`. */
export const kit = new NativeKit();
