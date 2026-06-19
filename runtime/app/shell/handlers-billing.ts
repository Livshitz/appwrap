import { Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

/**
 * In-app purchases — iOS StoreKit 1 (SKPaymentQueue). StoreKit 2 (Product/Transaction)
 * is Swift-only and unreachable via the ObjC bridge, so we use the delegate-based
 * SK1 API every NativeScript/Cordova IAP plugin uses. The web layer's validator turns
 * the returned app receipt into entitlements (server-of-record). Android billing is a
 * separate handler (Play Billing) and is currently unimplemented (capability 'none').
 */

declare const SKPaymentQueue: any;
declare const SKPayment: any;
declare const SKProductsRequest: any;
declare const SKProductsRequestDelegate: any;
declare const SKPaymentTransactionObserver: any;
declare const NSSet: any;
declare const NSBundle: any;
declare const NSData: any;
declare const NSNumberFormatter: any;

const PERIOD_UNIT = ['D', 'W', 'M', 'Y']; // SKProductPeriodUnit: Day/Week/Month/Year
const STATE = { Purchasing: 0, Purchased: 1, Failed: 2, Restored: 3, Deferred: 4 };
const SK_ERR_CANCELLED = 2; // SKErrorPaymentCancelled

function iosOnly(): Error {
  return Object.assign(new Error('iOS only — Android billing not wired'), { code: 'UNSUPPORTED' });
}
function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Base64 of the bundle's App Store receipt — the proof a validator sends to Apple. */
function appReceipt(): string {
  const url = NSBundle.mainBundle.appStoreReceiptURL;
  if (!url) return '';
  const data = NSData.dataWithContentsOfURL(url);
  return data ? data.base64EncodedStringWithOptions(0) : '';
}

function mapProduct(p: any) {
  const f = NSNumberFormatter.new();
  f.numberStyle = 2; // CurrencyStyle
  f.locale = p.priceLocale;
  const sp = p.subscriptionPeriod;
  return {
    id: String(p.productIdentifier),
    title: String(p.localizedTitle ?? ''),
    description: String(p.localizedDescription ?? ''),
    price: p.price ? p.price.doubleValue : 0,
    displayPrice: String(f.stringFromNumber(p.price) ?? ''),
    currency: String(p.priceLocale?.currencyCode ?? ''),
    type: sp ? 'autoRenewable' : 'unknown',
    subscriptionPeriod: sp ? `P${sp.numberOfUnits}${PERIOD_UNIT[sp.unit] ?? 'D'}` : undefined,
  };
}

function receiptFor(productId: string, transactionId?: string) {
  return { platform: 'ios', productId, transactionId, appReceipt: appReceipt(), raw: {} };
}

// In-flight resolvers, keyed so the single queue observer can route callbacks.
const purchaseWaiters = new Map<string, { resolve: (r: any) => void; reject: (e: any) => void }>();
let restoreWaiter: { receipts: any[]; resolve: (r: any[]) => void; reject: (e: any) => void } | null = null;
const productRequests = new Set<any>(); // keep strong refs to in-flight requests + delegates
let observer: any = null;

function buildObserver() {
  const ObserverClass = (NSObject as any).extend(
    {
      paymentQueueUpdatedTransactions(queue: any, transactions: any): void {
        const n = transactions.count;
        for (let i = 0; i < n; i++) {
          const t = transactions.objectAtIndex(i);
          const pid = String(t.payment.productIdentifier);
          switch (t.transactionState) {
            case STATE.Purchased: {
              queue.finishTransaction(t);
              const r = receiptFor(pid, String(t.transactionIdentifier ?? ''));
              bridge.emit('billing.transaction', r);
              purchaseWaiters.get(pid)?.resolve(r);
              purchaseWaiters.delete(pid);
              break;
            }
            case STATE.Restored: {
              queue.finishTransaction(t);
              const r = receiptFor(pid, String(t.transactionIdentifier ?? ''));
              if (restoreWaiter) restoreWaiter.receipts.push(r);
              bridge.emit('billing.transaction', r);
              break;
            }
            case STATE.Failed: {
              queue.finishTransaction(t);
              const cancelled = t.error && t.error.code === SK_ERR_CANCELLED;
              const e = err(cancelled ? 'DENIED' : 'NATIVE_ERROR', t.error?.localizedDescription ?? 'Purchase failed');
              purchaseWaiters.get(pid)?.reject(e);
              purchaseWaiters.delete(pid);
              break;
            }
            // Purchasing / Deferred: nothing to do.
          }
        }
      },
      paymentQueueRestoreCompletedTransactionsFinished(): void {
        restoreWaiter?.resolve(restoreWaiter.receipts);
        restoreWaiter = null;
      },
      paymentQueueRestoreCompletedTransactionsFailedWithError(_q: any, error: any): void {
        restoreWaiter?.reject(err('NATIVE_ERROR', error?.localizedDescription ?? 'Restore failed'));
        restoreWaiter = null;
      },
    },
    { protocols: [SKPaymentTransactionObserver] }
  );
  return ObserverClass.new();
}

/** One SKProductsRequest → resolves the raw SKProduct objects (used by both products + purchase). */
function requestSKProducts(ids: string[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const set = NSSet.setWithArray(ids as any);
    const request = SKProductsRequest.alloc().initWithProductIdentifiers(set);
    const DelegateClass = (NSObject as any).extend(
      {
        productsRequestDidReceiveResponse(_req: any, response: any): void {
          const out: any[] = [];
          const products = response.products;
          for (let i = 0; i < products.count; i++) out.push(products.objectAtIndex(i));
          productRequests.delete(holder);
          resolve(out);
        },
        requestDidFailWithError(_req: any, error: any): void {
          productRequests.delete(holder);
          reject(err('NATIVE_ERROR', error?.localizedDescription ?? 'Products request failed'));
        },
      },
      { protocols: [SKProductsRequestDelegate] }
    );
    const delegate = DelegateClass.new();
    const holder = { request, delegate };
    productRequests.add(holder); // strong ref until the callback fires
    request.delegate = delegate;
    request.start();
  });
}

export function registerBillingHandlers(): void {
  if (!isIOS) return; // Android billing is a separate, not-yet-wired handler

  observer = buildObserver();
  SKPaymentQueue.defaultQueue().addTransactionObserver(observer);

  bridge.register('billing.products', async ({ ids = [] }: { ids: string[] }) => {
    if (!ids.length) return [];
    return (await requestSKProducts(ids)).map(mapProduct);
  });

  bridge.register('billing.purchase', async ({ productId }: { productId: string }) => {
    if (!SKPaymentQueue.canMakePayments()) throw err('DENIED', 'Purchases disabled on this device');
    const sk = (await requestSKProducts([productId]))[0];
    if (!sk) throw err('NATIVE_ERROR', `Unknown product: ${productId}`);
    return new Promise((resolve, reject) => {
      purchaseWaiters.set(productId, { resolve, reject });
      SKPaymentQueue.defaultQueue().addPayment(SKPayment.paymentWithProduct(sk));
    });
  });

  bridge.register('billing.restore', () => restoreTransactions());

  // The bundle's App Store receipt, read straight from disk — NO Apple-ID prompt and no
  // store round-trip (unlike restore). For an in-place app update it already holds the
  // user's active/grandfathered subscriptions, so a server validator can confirm
  // entitlements silently. This is the zero-user-action path for migrating existing
  // subscribers into a new build of the SAME bundle id. Empty string if absent (e.g. a
  // dev build with no receipt) — the caller falls back to restore().
  bridge.register('billing.appReceipt', async () => ({ platform: 'ios', appReceipt: appReceipt() }));

  // Client-trusted entitlements: StoreKit 1 has no on-device entitlement list, so we
  // derive non-consumed/active products from a restore. Real apps plug in a server
  // validator (see kit.billing.configure) instead of trusting this.
  bridge.register('billing.entitlements', async () => {
    const receipts = await restoreTransactions();
    const seen = new Set<string>();
    const ents: any[] = [];
    for (const r of receipts) {
      if (seen.has(r.productId)) continue;
      seen.add(r.productId);
      ents.push({ productId: r.productId, active: true });
    }
    return ents;
  });

  bridge.register('billing.manageSubscriptions', () => {
    // StoreKit 2's AppStore.showManageSubscriptions is Swift-only; deep-link instead.
    Utils.openUrl('itms-apps://apps.apple.com/account/subscriptions');
  });
}

function restoreTransactions(): Promise<any[]> {
  if (restoreWaiter) return Promise.reject(err('NOT_READY', 'A restore is already in progress'));
  return new Promise((resolve, reject) => {
    restoreWaiter = { receipts: [], resolve, reject };
    SKPaymentQueue.defaultQueue().restoreCompletedTransactions();
  });
}
