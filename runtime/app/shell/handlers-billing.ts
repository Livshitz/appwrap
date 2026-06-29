import { Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { appwrapNativeLog } from './native-log';
import { SHELL_CONFIG } from './config';

// @objc Swift shim (AppwrapManageSubscriptions.swift, billing nativeSrc) — no NS types; bridges
// StoreKit 2's Swift-async showManageSubscriptions(in:) to a completion the ObjC bridge can call.
declare const AppwrapManageSubscriptions: { present(completion: (message: string | null) => void): void };

/**
 * In-app purchases — iOS StoreKit 1 (SKPaymentQueue). StoreKit 2 (Product/Transaction)
 * is Swift-only and unreachable via the ObjC bridge, so we use the delegate-based
 * SK1 API every NativeScript/Cordova IAP plugin uses. The web layer's validator turns
 * the returned app receipt into entitlements (server-of-record). Android billing is a
 * separate handler (Play Billing) and is currently unimplemented (capability 'none').
 */

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
  // 0 = NSDataBase64Encoding default (no options); enum-cast for the typed selector.
  return data ? data.base64EncodedStringWithOptions(0 as unknown as NSDataBase64EncodingOptions) : '';
}

function mapProduct(p: SKProduct) {
  const f = NSNumberFormatter.new();
  f.numberStyle = 2; // CurrencyStyle
  f.locale = p.priceLocale;
  const sp = p.subscriptionPeriod;
  return {
    id: String(p.productIdentifier),
    title: String(p.localizedTitle ?? ''),
    description: String(p.localizedDescription ?? ''),
    price: p.price ? p.price.doubleValue : 0,
    // stringFromNumber takes an NSNumber* at runtime; the .d.ts types it as number, so cast the NSDecimalNumber.
    displayPrice: String(f.stringFromNumber(p.price as unknown as number) ?? ''),
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
const productRequests = new Set<{ request: SKProductsRequest; delegate: any }>(); // keep strong refs to in-flight requests + delegates
let observer: any = null;

// iOS-only StoreKit delegates. Defined lazily inside an isIOS-gated factory (mirrors banner.ts) so the
// shared module can instantiate on Android — NSObject/SK* are iOS globals, and a top-level
// `extends NSObject` would evaluate at ES-module load and crash the Android shell.
// any: module-level holders for runtime-built ObjC subclasses; each class BODY stays fully typed.
let PaymentObserver: any, ProductsDelegate: any;
function ensureIosDelegates(): void {
  if (!isIOS || PaymentObserver) return;

  // SKPaymentQueue transaction observer. State (purchaseWaiters/restoreWaiter) lives at module
  // scope, so the delegate needs no instance fields.
  @NativeClass()
  class PaymentObserverImpl extends NSObject implements SKPaymentTransactionObserver {
    static ObjCProtocols = [SKPaymentTransactionObserver];
    static new(): PaymentObserverImpl {
      return <PaymentObserverImpl>super.new();
    }
    paymentQueueUpdatedTransactions(queue: SKPaymentQueue, transactions: NSArray<SKPaymentTransaction>): void {
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
    }
    paymentQueueRestoreCompletedTransactionsFinished(_queue: SKPaymentQueue): void {
      restoreWaiter?.resolve(restoreWaiter.receipts);
      restoreWaiter = null;
    }
    paymentQueueRestoreCompletedTransactionsFailedWithError(_queue: SKPaymentQueue, error: NSError): void {
      restoreWaiter?.reject(err('NATIVE_ERROR', error?.localizedDescription ?? 'Restore failed'));
      restoreWaiter = null;
    }
  }
  PaymentObserver = PaymentObserverImpl;

  // SKProductsRequest delegate. Closure-captured state (resolve/reject + the strong-ref holder)
  // is held as instance fields, assigned after new().
  @NativeClass()
  class ProductsDelegateImpl extends NSObject implements SKProductsRequestDelegate {
    static ObjCProtocols = [SKProductsRequestDelegate];
    onResolve?: (products: SKProduct[]) => void;
    onReject?: (e: Error) => void;
    holder?: { request: SKProductsRequest; delegate: any };
    static new(): ProductsDelegateImpl {
      return <ProductsDelegateImpl>super.new();
    }
    productsRequestDidReceiveResponse(_request: SKProductsRequest, response: SKProductsResponse): void {
      const out: SKProduct[] = [];
      const products = response.products;
      for (let i = 0; i < products.count; i++) out.push(products.objectAtIndex(i));
      if (this.holder) productRequests.delete(this.holder);
      this.onResolve?.(out);
    }
    requestDidFailWithError(_request: SKRequest, error: NSError): void {
      if (this.holder) productRequests.delete(this.holder);
      this.onReject?.(err('NATIVE_ERROR', error?.localizedDescription ?? 'Products request failed'));
    }
  }
  ProductsDelegate = ProductsDelegateImpl;
}

function buildObserver(): any {
  return PaymentObserver.new();
}

/** One SKProductsRequest → resolves the raw SKProduct objects (used by both products + purchase). */
function requestSKProducts(ids: string[]): Promise<SKProduct[]> {
  return new Promise((resolve, reject) => {
    const set = NSSet.setWithArray<string>(ids);
    const request = SKProductsRequest.alloc().initWithProductIdentifiers(set);
    const delegate = ProductsDelegate.new();
    const holder = { request, delegate };
    delegate.onResolve = resolve;
    delegate.onReject = reject;
    delegate.holder = holder;
    productRequests.add(holder); // strong ref until the callback fires
    request.delegate = delegate;
    request.start();
  });
}

export function registerBillingHandlers(): void {
  if (!isIOS) return; // Android billing is a separate, not-yet-wired handler

  ensureIosDelegates();
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
    // DEFAULT: StoreKit 1 deep-link — correct for production, but leaves the app and doesn't show
    // sandbox/TestFlight subs. The in-app sheet is the opt-in `billing.manageSubscriptionsSheet` below.
    Utils.openUrl('itms-apps://apps.apple.com/account/subscriptions');
  });

  // OPT-IN (iOS 15+): StoreKit 2's in-app management sheet via the AppwrapManageSubscriptions Swift
  // shim — shows the user's subs (incl. sandbox/TestFlight) and lets them cancel without leaving the
  // app. Reached only when the app calls kit.billing.showManageSubscriptionsSheet(), so the default
  // deep-link path above is untouched. Rejects on iOS <15, no scene, or a StoreKit error.
  bridge.register('billing.manageSubscriptionsSheet', () => {
    return new Promise<void>((resolve, reject) => {
      AppwrapManageSubscriptions.present((message: string | null) => {
        if (SHELL_CONFIG.debug) appwrapNativeLog(`[native:lifecycle] manageSubscriptionsSheet done err=${message ?? 'none'}`);
        // The sheet dismisses WITHOUT the app scene leaving foregroundActive → no resumeEvent, and it
        // orphans a touch-stealing window above ours. Recover from this completion (the only callback
        // that fires). Shared across all native surfaces; see CustomWebView.recoverAfterNativeSurface.
        // NOTE: redundant with the global UIWindowDidBecomeHidden observer (armNativeSurfaceRecovery in
        // main-page.ts) — kept as the proven baseline; remove the per-handler calls once that observer
        // is device-verified to fire on this dismiss. Double-recovery is safe (coalesced + no-op clean).
        bridge.getWebView()?.recoverAfterNativeSurface();
        if (message) reject(err('NATIVE_ERROR', message));
        else resolve();
      });
    });
  });
}

function restoreTransactions(): Promise<any[]> {
  if (restoreWaiter) return Promise.reject(err('NOT_READY', 'A restore is already in progress'));
  return new Promise((resolve, reject) => {
    restoreWaiter = { receipts: [], resolve, reject };
    SKPaymentQueue.defaultQueue().restoreCompletedTransactions();
  });
}
