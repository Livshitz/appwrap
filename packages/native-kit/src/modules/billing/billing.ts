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

  /** Out-of-band transactions (renewals, Ask-to-Buy, cross-device). Native streams only. */
  onTransaction(cb: (receipt: PurchaseReceipt) => void): Unsubscribe {
    return this.kit.on('billing.transaction', (p) => cb(p as PurchaseReceipt));
  }

  /** Raw device entitlements — StoreKit `currentEntitlements` / Play `queryPurchases`. */
  private nativeEntitlements(): Promise<Entitlement[]> {
    return this.kit.invoke('billing.entitlements');
  }
}
