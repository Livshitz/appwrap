import type { NativeKit } from '../../core/NativeKit';
import { KitError, type Capability, type Unsubscribe } from '../../core/types';
import { ClientTrustedValidator } from './validators';
import type { BillingProvider, BillingValidator, Entitlement, Product, PurchaseReceipt, PurchaseResult } from './types';

/**
 * In-app purchases & subscriptions — ONE API across web and native.
 *
 * - On a native shell the kit drives the device store (iOS StoreKit 1, Android Play
 *   Billing) and a {@link BillingValidator} confirms the receipt (server-of-record).
 * - On the web there is no native store, so the app plugs in a {@link BillingProvider}
 *   (Stripe / Paddle / custom backend) and the SAME `kit.billing.*` calls dispatch to it.
 *
 * Wire both once via {@link configure}; the module picks the right path per platform.
 */
export class BillingModule {
  private validator: BillingValidator;
  private webProvider?: BillingProvider;

  constructor(private kit: NativeKit) {
    this.validator = new ClientTrustedValidator(() => this.nativeEntitlements());
  }

  /** 'native' on a store-capable shell · 'web' when a web provider is wired · else 'none'. */
  get capability(): Capability {
    if (this.kit.is.native) return this.kit.capability('billing'); // native store (or 'none' if parked)
    return this.webProvider ? 'web' : 'none'; // never silently fall back to web inside a native shell
  }

  /**
   * @param opts.validator   server-of-record for entitlements (native receipt check; shared)
   * @param opts.webProvider purchase mechanism on the web (Stripe/Paddle/custom)
   */
  configure(opts: { validator?: BillingValidator; webProvider?: BillingProvider }): void {
    if (opts.validator) this.validator = opts.validator;
    if (opts.webProvider) this.webProvider = opts.webProvider;
  }

  /** On the web the purchase mechanism is the provider; require one with an actionable error. */
  private webProviderOrThrow(): BillingProvider {
    if (!this.webProvider) {
      throw new KitError(
        'UNSUPPORTED',
        'No web billing provider configured. On the web, wire one: ' +
          "kit.billing.configure({ webProvider: new HttpBillingProvider({ baseUrl: '/api/billing' }) })"
      );
    }
    return this.webProvider;
  }

  /** Localized product catalog — from the store (native) or the provider (web). */
  async products(ids: string[]): Promise<Product[]> {
    await this.kit.ready(); // routing depends on the resolved adapter — never decide pre-handshake
    if (this.kit.is.web) return this.webProviderOrThrow().products(ids);
    return this.kit.invoke('billing.products', { ids });
  }

  /** Buy a product. Native store flow + receipt validation, or web checkout via the provider. */
  async purchase(productId: string): Promise<PurchaseResult> {
    await this.kit.ready();
    if (this.kit.is.web) {
      const entitlements = await this.webProviderOrThrow().purchase(productId);
      return { receipt: { platform: 'web', productId, raw: null }, entitlements };
    }
    const receipt = await this.kit.invoke<PurchaseReceipt>('billing.purchase', { productId }, { timeoutMs: 120_000 });
    return { receipt, entitlements: await this.validator.validate(receipt) };
  }

  /** Restore/re-sync prior purchases. */
  async restore(): Promise<Entitlement[]> {
    await this.kit.ready();
    if (this.kit.is.web) {
      const p = this.webProviderOrThrow();
      return (p.restore ?? p.entitlements).call(p); // web has no store "restore" → re-read entitlements
    }
    const receipts = await this.kit.invoke<PurchaseReceipt[]>('billing.restore', undefined, { timeoutMs: 60_000 });
    const out: Entitlement[] = [];
    for (const r of receipts) out.push(...(await this.validator.validate(r)));
    return out;
  }

  /**
   * Confirm entitlements **silently** from the on-device App Store receipt — no Apple-ID
   * prompt and no `restore()` round-trip (unlike {@link restore}/{@link entitlements} on
   * StoreKit 1). For an in-place update of the SAME bundle id the receipt already holds the
   * user's active/grandfathered subscriptions, so this is the zero-user-action path for
   * migrating existing subscribers into a new build.
   *
   * Native iOS only, and only meaningful with a **server validator** (the bare receipt has no
   * product id — a client-trusted validator can't interpret it). Resolves `[]` on the web,
   * on Android (no StoreKit-1 receipt), or when no receipt is present (e.g. a dev build).
   */
  async entitlementsFromReceipt(): Promise<Entitlement[]> {
    await this.kit.ready();
    if (this.capability !== 'native') return []; // web, or a shell with no native store handler (Android today)
    if (this.validator instanceof ClientTrustedValidator) return []; // bare receipt has no product id → would grant a bogus active entitlement; needs a server validator
    const receipt = await this.kit.invoke<PurchaseReceipt>('billing.appReceipt');
    if (!receipt?.appReceipt) return [];
    return this.validator.validate(receipt); // server-of-record turns the receipt into entitlements
  }

  /** Current entitlements from the configured server-of-record (web provider or validator). */
  async entitlements(): Promise<Entitlement[]> {
    await this.kit.ready();
    if (this.kit.is.web) return this.webProviderOrThrow().entitlements();
    return this.validator.entitlements();
  }

  /** Subscription management — OS surface (App Store / Play) or the provider's portal (Stripe). */
  async manageSubscriptions(): Promise<void> {
    await this.kit.ready();
    if (this.kit.is.web) {
      const p = this.webProviderOrThrow();
      if (!p.manageSubscriptions) throw new KitError('UNSUPPORTED', 'This web billing provider has no subscription-management portal');
      return p.manageSubscriptions();
    }
    return this.kit.invoke('billing.manageSubscriptions');
  }

  /**
   * iOS 15+ native-only: present StoreKit 2's **in-app** subscription-management sheet
   * (`AppStore.showManageSubscriptions(in:)`). Unlike {@link manageSubscriptions} (which deep-links
   * out to the App Store account page, StoreKit 1), this stays inside the app AND shows sandbox /
   * TestFlight subscriptions — so it's the path to verify/cancel a sub during testing. Opt-in: the
   * default `manageSubscriptions()` deep-link is unchanged; call this explicitly to use the sheet.
   *
   * Throws `UNSUPPORTED` on the web or Android (no StoreKit), and `NATIVE_ERROR` on iOS <15 / no
   * presentable scene / a StoreKit error. Resolves once the user dismisses the sheet.
   */
  async showManageSubscriptionsSheet(): Promise<void> {
    await this.kit.ready();
    if (this.capability !== 'native') {
      throw new KitError('UNSUPPORTED', 'The in-app subscriptions sheet is iOS-only (StoreKit 2). Use manageSubscriptions() on web/Android.');
    }
    // The sheet resolves only when the USER dismisses it (seconds to minutes), so the default 10s
    // invoke timeout would fire mid-sheet and make the caller think it failed → a spurious fallback.
    // Give it a long window; a dismissed-but-unreported sheet just leaves the promise pending (harmless).
    return this.kit.invoke('billing.manageSubscriptionsSheet', undefined, { timeoutMs: 600_000 });
  }

  /** Out-of-band transactions (renewals, Ask-to-Buy, cross-device). Native streams only. */
  onTransaction(cb: (receipt: PurchaseReceipt) => void): Unsubscribe {
    return this.kit.on('billing.transaction', (p) => cb(p as PurchaseReceipt));
  }

  /** Raw device entitlements — StoreKit `currentEntitlements` / Play `queryPurchases`. */
  private nativeEntitlements(): Promise<Entitlement[]> {
    return this.kit.invoke('billing.entitlements');
  }
}
