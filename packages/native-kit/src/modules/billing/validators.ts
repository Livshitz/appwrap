import { httpJson, type HeaderProvider } from './http';
import type { BillingValidator, Entitlement, PurchaseReceipt } from './types';

export type { HeaderProvider } from './http';

/**
 * Trusts the device. `validate` marks the purchased product active; `entitlements`
 * reads whatever the native layer reports (StoreKit `currentEntitlements` /
 * Play `queryPurchases`). Zero backend — spoofable on a compromised device, so
 * fine for demos/dev or low-stakes unlocks, NOT for real revenue. The default.
 */
export class ClientTrustedValidator implements BillingValidator {
  constructor(private readNative: () => Promise<Entitlement[]>) {}

  async validate(receipt: PurchaseReceipt): Promise<Entitlement[]> {
    // The native purchase already succeeded — grant that product directly. Do NOT
    // read native entitlements here: on StoreKit 1 that means a restore, which pops
    // an Apple ID prompt right after a buy. Call entitlements() explicitly for that.
    return [{ productId: receipt.productId, active: true, purchasedAt: Date.now() }];
  }

  entitlements(): Promise<Entitlement[]> {
    return this.readNative();
  }
}

export class HttpValidatorOptions {
  /** POST endpoint that receives a `PurchaseReceipt` and returns entitlements. */
  validateUrl = '';
  /** GET/POST endpoint for the current entitlements. Defaults to `validateUrl`. */
  entitlementsUrl?: string;
  /** Static headers or a thunk (e.g. to inject a fresh bearer token). */
  headers?: HeaderProvider;
  /** Map the provider's response JSON → `Entitlement[]`. Default expects `{ entitlements: [...] }`. */
  mapResponse: (json: any) => Entitlement[] = (j) => (j?.entitlements ?? []) as Entitlement[];
  /** Injected for tests / non-DOM runtimes. Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Generic server-validated strategy. One implementation covers RevenueCat,
 * IAPHUB, or any custom backend — they differ only by URL, auth header, and a small
 * response mapper. HTTP over SDK by design (no vendor packages).
 */
export class HttpValidator implements BillingValidator {
  public options: HttpValidatorOptions;
  constructor(options?: Partial<HttpValidatorOptions>) {
    this.options = { ...new HttpValidatorOptions(), ...options };
    if (!this.options.validateUrl) throw new Error('HttpValidator: validateUrl is required');
  }

  async validate(receipt: PurchaseReceipt): Promise<Entitlement[]> {
    const json = await httpJson({ ...this.req(), url: this.options.validateUrl, method: 'POST', body: receipt });
    return this.options.mapResponse(json);
  }

  async entitlements(): Promise<Entitlement[]> {
    const url = this.options.entitlementsUrl ?? this.options.validateUrl;
    const method = this.options.entitlementsUrl ? 'GET' : 'POST';
    return this.options.mapResponse(await httpJson({ ...this.req(), url, method }));
  }

  private req() {
    return { headers: this.options.headers, fetch: this.options.fetch };
  }
}
