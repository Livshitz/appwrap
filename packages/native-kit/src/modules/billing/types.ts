/** Billing / IAP contract — platform-neutral shapes shared by the module,
 *  the native handlers, and any pluggable validator (RevenueCat / IAPHUB / custom). */

export type ProductType =
  | 'consumable'
  | 'nonConsumable'
  | 'autoRenewable'
  | 'nonRenewable'
  | 'unknown';

/** A purchasable product as the store describes it (localized). */
export interface Product {
  id: string;
  title: string;
  description: string;
  /** Numeric price in `currency`, for math/sorting. */
  price: number;
  /** Localized formatted price, e.g. "$4.99" — show this to users. */
  displayPrice: string;
  currency: string;
  type: ProductType;
  /** ISO-8601 duration for auto-renewables, e.g. "P1M", "P1Y". */
  subscriptionPeriod?: string;
}

/** A normalized entitlement — "this user owns/subscribes to X". */
export interface Entitlement {
  productId: string;
  active: boolean;
  /** Epoch ms; subscriptions only. */
  expiresAt?: number;
  /** Whether an auto-renewable will renew at period end. */
  willRenew?: boolean;
  /** Epoch ms of the original purchase. */
  purchasedAt?: number;
}

/** The raw proof of a purchase, handed to the validator. Platform-specific fields
 *  are optional so one shape serves both stores AND a web checkout. */
export interface PurchaseReceipt {
  platform: 'ios' | 'android' | 'web';
  productId: string;
  transactionId?: string;
  /** StoreKit 2 signed transaction (JWS) — verify against Apple's root certs. */
  jws?: string;
  /** Base64 StoreKit 1 app receipt — verify via App Store Server API / verifyReceipt. */
  appReceipt?: string;
  /** Google Play Billing purchase token — verify via Play Developer API. */
  purchaseToken?: string;
  /** Web checkout reference (e.g. Stripe Checkout Session / subscription id). */
  providerRef?: string;
  /** The untouched native/provider payload, for validators that want everything. */
  raw: unknown;
}

export interface PurchaseResult {
  receipt: PurchaseReceipt;
  entitlements: Entitlement[];
}

/**
 * The swappable seam. The kit owns the on-device purchase flow; *who decides the
 * user is actually entitled* is up to the app. Implement this (or configure the
 * bundled `HttpValidator`) to point at RevenueCat, IAPHUB, or your own backend.
 */
export interface BillingValidator {
  /** Validate a fresh purchase/restore receipt → the entitlements it grants. */
  validate(receipt: PurchaseReceipt): Promise<Entitlement[]>;
  /** Current entitlements from the server-of-record (or the device, for client-trusted). */
  entitlements(): Promise<Entitlement[]>;
}

/**
 * The *purchase mechanism* on web — the symmetric counterpart to the native store.
 * On mobile the kit drives StoreKit/Play directly; on web there is no native store,
 * so the app plugs in a provider (Stripe / Paddle / LemonSqueezy / custom backend).
 * The same `kit.billing.*` calls dispatch here when running on the web. Implement this,
 * or configure the bundled `HttpBillingProvider` (backend-driven hosted checkout).
 */
export interface BillingProvider {
  /** Catalog with localized prices (typically from your backend / Stripe prices). */
  products(ids: string[]): Promise<Product[]>;
  /** Start checkout for a product. Resolves to the granted entitlements when known
   *  synchronously; for redirect-based checkout (Stripe hosted page) it navigates away
   *  and the entitlements surface via `entitlements()` after the redirect back. */
  purchase(productId: string): Promise<Entitlement[]>;
  /** Current entitlements from the server-of-record (Stripe webhooks → your backend). */
  entitlements(): Promise<Entitlement[]>;
  /** Re-sync entitlements (web has no "restore" — defaults to `entitlements()`). */
  restore?(): Promise<Entitlement[]>;
  /** Open the billing/subscription-management surface (e.g. Stripe Billing Portal). */
  manageSubscriptions?(): Promise<void>;
}
