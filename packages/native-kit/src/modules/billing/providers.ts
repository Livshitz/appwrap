import { httpJson, type HeaderProvider } from './http';
import type { BillingProvider, Entitlement, Product } from './types';

export class HttpBillingProviderOptions {
  /** Backend base URL exposing /products, /checkout, /entitlements, /portal. */
  baseUrl = '';
  /** Static headers or a thunk (e.g. a fresh session/bearer token). */
  headers?: HeaderProvider;
  /** Injected for tests / non-DOM runtimes. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** How to send the user to a hosted checkout / portal URL. Defaults to a same-tab
   *  navigation — override to open a tab, an in-app browser, etc. */
  redirect: (url: string) => void = (url) => {
    if (typeof window !== 'undefined') window.location.assign(url);
  };
  mapProducts: (json: any) => Product[] = (j) => (j?.products ?? j ?? []) as Product[];
  mapEntitlements: (json: any) => Entitlement[] = (j) => (j?.entitlements ?? j ?? []) as Entitlement[];
}

/**
 * Web checkout via your backend — the symmetric counterpart to the native store.
 * `purchase()` POSTs to `/checkout`; if the backend returns a hosted-checkout `url`
 * (Stripe Checkout Session, Paddle, LemonSqueezy…), it redirects and entitlements
 * surface on the redirect back; if the backend returns `entitlements` inline, it
 * resolves immediately. One config covers any "backend mints a checkout URL" provider.
 * HTTP over SDK by design — no Stripe.js / vendor packages in the kit.
 */
export class HttpBillingProvider implements BillingProvider {
  public options: HttpBillingProviderOptions;
  constructor(options?: Partial<HttpBillingProviderOptions>) {
    this.options = { ...new HttpBillingProviderOptions(), ...options };
    if (!this.options.baseUrl) throw new Error('HttpBillingProvider: baseUrl is required');
  }

  async products(ids: string[]): Promise<Product[]> {
    const url = `${this.base()}/products?ids=${encodeURIComponent(ids.join(','))}`;
    return this.options.mapProducts(await httpJson({ ...this.req(), url, method: 'GET' }));
  }

  async purchase(productId: string): Promise<Entitlement[]> {
    const json = await httpJson({ ...this.req(), url: `${this.base()}/checkout`, method: 'POST', body: { productId } });
    if (json?.url) {
      this.options.redirect(String(json.url)); // hosted checkout — page navigates away
      return []; // entitlements arrive via entitlements() after redirect-back
    }
    return this.options.mapEntitlements(json); // backend completed inline
  }

  async entitlements(): Promise<Entitlement[]> {
    return this.options.mapEntitlements(await httpJson({ ...this.req(), url: `${this.base()}/entitlements`, method: 'GET' }));
  }

  restore(): Promise<Entitlement[]> {
    return this.entitlements(); // web has no store "restore" — re-read the server-of-record
  }

  async manageSubscriptions(): Promise<void> {
    const json = await httpJson({ ...this.req(), url: `${this.base()}/portal`, method: 'POST', body: {} });
    if (json?.url) this.options.redirect(String(json.url)); // Stripe Billing Portal, etc.
  }

  private base() {
    return this.options.baseUrl.replace(/\/$/, '');
  }
  private req() {
    return { headers: this.options.headers, fetch: this.options.fetch };
  }
}
