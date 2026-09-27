import { Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { createUiDelegate } from './ios-ui-delegate';

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/** WKWebView properties whose change is a navigation-state change (KVO-observable). */
const KVO_KEYS = ['URL', 'title', 'canGoBack', 'canGoForward', 'loading'];

/**
 * In-app WebView OVERLAY (iOS) — a second, full WKWebView layered over the app's own WebView, below
 * `top` CSS px (so the page keeps its own top bar visible above it). Unlike `browser.open`
 * (SFSafariViewController: modal, its own chrome, isolated cookies), this is chrome-less, page-driven
 * and shares the PERSISTENT default data store (cookies/logins survive relaunch).
 *
 *   webview.open  {url, top?}                   — show (or, if open, navigate + show)
 *   webview.nav   {op:'back'|'forward'|'reload'|'go', url?}
 *   webview.hide / webview.show                 — keep state, reveal/cover the page beneath
 *   webview.close                               — tear down; emits `webview.closed`
 * Events: `webview.state` {url,title,canGoBack,canGoForward,loading} on every navigation change.
 *
 * Swipe back/forward on, target=_blank/window.open loads in place (shared ios-ui-delegate), keyboard +
 * safe areas handled by WKWebView's own scroll-view insets (contentInsetAdjustment automatic).
 * iOS-only (the manifest advertises android:false → kit capability 'none').
 */
export function registerWebViewHandlers(): void {
  if (isIOS) registerIos();
}

function registerIos(): void {
  // Strong refs — WKWebView holds its delegates weakly and KVO observers aren't retained.
  let wv: WKWebView | null = null;
  let observer: NSObject | null = null;
  let uiDelegate: WKUIDelegate | null = null;
  let topConstraint: NSLayoutConstraint | null = null;
  let emitQueued = false;
  let ObserverClass: any; // KVO sink, built once (ObjC class names are global)

  const state = () => ({
    url: wv?.URL?.absoluteString ?? '',
    title: wv?.title ?? '',
    canGoBack: !!wv?.canGoBack,
    canGoForward: !!wv?.canGoForward,
    loading: !!wv?.loading,
  });

  // Several KVO keys flip together on one navigation — coalesce into one event per runloop turn.
  const emitState = () => {
    if (emitQueued) return;
    emitQueued = true;
    setTimeout(() => { emitQueued = false; if (wv) bridge.emit('webview.state', state()); }, 0);
  };

  const load = (url: string) => {
    const nsUrl = NSURL.URLWithString(url);
    if (!nsUrl) throw err('NATIVE_ERROR', `webview: invalid url ${url}`);
    wv!.loadRequest(NSURLRequest.requestWithURL(nsUrl));
  };

  const create = (top: number) => {
    const host = bridge.getWebView()?.ios as WKWebView | undefined;
    const container = host?.superview ?? Utils.ios.getRootViewController()?.view;
    if (!container) throw err('NATIVE_ERROR', 'webview.open: no host view');

    const config = WKWebViewConfiguration.new();
    config.websiteDataStore = WKWebsiteDataStore.defaultDataStore();
    config.allowsInlineMediaPlayback = true;
    const view = WKWebView.alloc().initWithFrameConfiguration(CGRectZero, config);
    view.allowsBackForwardNavigationGestures = true;
    uiDelegate = createUiDelegate();
    view.UIDelegate = uiDelegate;
    if (host?.backgroundColor) { view.backgroundColor = host.backgroundColor; view.opaque = false; }
    if ((view as any).inspectable !== undefined) (view as any).inspectable = true; // iOS 16.4+ Safari inspector

    view.translatesAutoresizingMaskIntoConstraints = false;
    container.addSubview(view);
    // Anchor to the app WebView's box so `top` is in the page's own CSS px (== points).
    const ref: any = host ?? container;
    topConstraint = view.topAnchor.constraintEqualToAnchorConstant(ref.topAnchor, top);
    NSLayoutConstraint.activateConstraints([
      topConstraint,
      view.leadingAnchor.constraintEqualToAnchor(ref.leadingAnchor),
      view.trailingAnchor.constraintEqualToAnchor(ref.trailingAnchor),
      view.bottomAnchor.constraintEqualToAnchor(ref.bottomAnchor),
    ] as any);

    ObserverClass ??= (NSObject as any).extend(
      { observeValueForKeyPathOfObjectChangeContext() { emitState(); } },
      { name: 'AppwrapWebViewOverlayObserver' }
    );
    observer = ObserverClass.new();
    for (const k of KVO_KEYS) view.addObserverForKeyPathOptionsContext(observer!, k, NSKeyValueObservingOptions.New, null);
    wv = view;
  };

  const destroy = () => {
    if (!wv) return;
    for (const k of KVO_KEYS) { try { wv.removeObserverForKeyPath(observer!, k); } catch { /* not observed */ } }
    wv.stopLoading();
    wv.removeFromSuperview();
    wv = null; observer = null; uiDelegate = null; topConstraint = null;
    bridge.emit('webview.closed', {});
  };

  const onMain = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve, reject) => Utils.dispatchToMainThread(() => {
      try { resolve(fn()); } catch (e) { reject(e); }
    }));

  bridge.register('webview.open', ({ url, top }: { url: string; top?: number }) => {
    const target = String(url ?? '');
    if (!target) throw err('NATIVE_ERROR', 'webview.open: empty url');
    const offset = Math.max(0, Number(top) || 0);
    return onMain(() => {
      if (!wv) create(offset);
      else if (topConstraint) topConstraint.constant = offset;
      wv!.hidden = false;
      wv!.superview?.bringSubviewToFront(wv!);
      load(target);
      return state();
    });
  });

  bridge.register('webview.nav', ({ op, url }: { op: string; url?: string }) =>
    onMain(() => {
      if (!wv) throw err('NATIVE_ERROR', 'webview.nav: not open');
      if (op === 'back') { if (wv.canGoBack) wv.goBack(); }
      else if (op === 'forward') { if (wv.canGoForward) wv.goForward(); }
      else if (op === 'reload') wv.reload();
      else if (op === 'go') load(String(url ?? ''));
      else throw err('NATIVE_ERROR', `webview.nav: unknown op ${op}`);
      return state();
    })
  );

  bridge.register('webview.hide', () => onMain(() => { if (wv) wv.hidden = true; return { open: !!wv }; }));
  bridge.register('webview.show', () => onMain(() => {
    if (wv) { wv.hidden = false; wv.superview?.bringSubviewToFront(wv); }
    return { open: !!wv };
  }));
  bridge.register('webview.close', () => onMain(() => { destroy(); }));
}
