import { Utils, isIOS, isAndroid, Application } from '@nativescript/core';
import { bridge } from './bridge';
import { createUiDelegate } from './ios-ui-delegate';
import { handleWebPermissionRequest } from './android-helpers';
import { SHELL_CONFIG } from './config';

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/** WKWebView properties whose change is a navigation-state change (KVO-observable). */
const KVO_KEYS = ['URL', 'title', 'canGoBack', 'canGoForward', 'loading'];

/**
 * In-app WebView OVERLAY (iOS) — a second, full WKWebView layered over the app's own WebView, below
 * `top` CSS px and above `bottom` CSS px (so the page keeps its own top bar / bottom dock visible). Unlike `browser.open`
 * (SFSafariViewController: modal, its own chrome, isolated cookies), this is chrome-less, page-driven
 * and shares the PERSISTENT default data store (cookies/logins survive relaunch).
 *
 *   webview.open  {url, top?, bottom?}          — show (or, if open, navigate + show / re-inset)
 *   webview.nav   {op:'back'|'forward'|'reload'|'go', url?}
 *   webview.hide / webview.show {top?,bottom?}  — keep state, reveal/cover the page beneath (show re-insets)
 *   webview.close                               — tear down; emits `webview.closed`
 *   webview.cookies {cookies: Cookie[]}         — write cookies into the overlay's (persistent) jar; resolves {set}
 *                                                 once all are stored (Bare Remote's opt-in "sign in like the Mac")
 *   webview.snapshot {width?, quality?}         — what the overlay shows now as a JPEG ~`width` px wide (default 360,
 *                                                 quality 0.6); resolves {jpeg: base64, width, height}. Must run while
 *                                                 it is still shown (take it before hide/close).
 * Events: `webview.state` {url,title,canGoBack,canGoForward,loading} on every navigation change.
 *
 * Swipe back/forward on, target=_blank/window.open loads in place (shared ios-ui-delegate), keyboard +
 * safe areas handled by WKWebView's own scroll-view insets (contentInsetAdjustment automatic).
 * Android: an android.webkit.WebView added to the activity's content frame, margins derived from the app
 * WebView's box (re-applied when it re-lays out), cookies via the process-wide CookieManager (persistent),
 * getUserMedia via the shared permission handler, _blank in place (no multiple-window support).
 */
/** A cookie as data (Bare's desktop `remote.cookies` shape); `expires` = unix seconds, absent = session cookie. */
type Cookie = { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; expires?: number | null; sameSite?: string | null };
const cookieList = (p: { cookies?: Cookie[] } | null): Cookie[] => {
  const l = p?.cookies;
  if (!Array.isArray(l)) throw err('NATIVE_ERROR', 'webview.cookies: cookies[] required');
  return l.filter((c) => c && c.name && c.domain);
};

/** webview.snapshot params → target pixel width (clamped) + JPEG quality 0..1. */
const snapOpts = (p?: { width?: number; quality?: number } | null) => ({
  width: Math.round(Math.min(1024, Math.max(64, Number(p?.width) || 360))),
  quality: Math.min(1, Math.max(0.1, Number(p?.quality) || 0.6)),
});

export function registerWebViewHandlers(): void {
  if (isIOS) registerIos();
  else if (isAndroid) registerAndroid();
}



function registerIos(): void {
  // Strong refs — WKWebView holds its delegates weakly and KVO observers aren't retained.
  let wv: WKWebView | null = null;
  let observer: NSObject | null = null;
  let uiDelegate: WKUIDelegate | null = null;
  let topConstraint: NSLayoutConstraint | null = null;
  let bottomConstraint: NSLayoutConstraint | null = null;
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

  const create = (top: number, bottom: number) => {
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
    // Anchor to the app WebView's box so `top`/`bottom` are in the page's own CSS px (== points).
    const ref: any = host ?? container;
    topConstraint = view.topAnchor.constraintEqualToAnchorConstant(ref.topAnchor, top);
    bottomConstraint = view.bottomAnchor.constraintEqualToAnchorConstant(ref.bottomAnchor, -bottom);
    NSLayoutConstraint.activateConstraints([
      topConstraint,
      bottomConstraint,
      view.leadingAnchor.constraintEqualToAnchor(ref.leadingAnchor),
      view.trailingAnchor.constraintEqualToAnchor(ref.trailingAnchor),
    ] as any);

    ObserverClass ??= (NSObject as any).extend(
      {
        observeValueForKeyPathOfObjectChangeContext() {
          // Shell-coloured + non-opaque only to avoid a white flash before the first load; after it, WebKit
          // must paint the page's own canvas, or a page with no background shows the (dark) shell through.
          if (wv && !wv.opaque && !wv.loading && wv.URL) wv.opaque = true;
          emitState();
        },
      },
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
    wv = null; observer = null; uiDelegate = null; topConstraint = null; bottomConstraint = null;
    bridge.emit('webview.closed', {});
  };

  const onMain = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve, reject) => Utils.dispatchToMainThread(() => {
      try { resolve(fn()); } catch (e) { reject(e); }
    }));

  const inset = (v?: number) => Math.max(0, Number(v) || 0);
  /** Re-apply insets on a live overlay; an omitted side keeps its current value. */
  const setInsets = (top?: number, bottom?: number) => {
    if (top !== undefined && topConstraint) topConstraint.constant = inset(top);
    if (bottom !== undefined && bottomConstraint) bottomConstraint.constant = -inset(bottom);
  };

  bridge.register('webview.open', ({ url, top, bottom }: { url: string; top?: number; bottom?: number }) => {
    const target = String(url ?? '');
    if (!target) throw err('NATIVE_ERROR', 'webview.open: empty url');
    return onMain(() => {
      if (!wv) create(inset(top), inset(bottom));
      else setInsets(top, bottom);
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
  bridge.register('webview.show', (p?: { top?: number; bottom?: number } | null) => onMain(() => {
    if (wv) { setInsets(p?.top, p?.bottom); wv.hidden = false; wv.superview?.bringSubviewToFront(wv); }
    return { open: !!wv };
  }));
  bridge.register('webview.close', () => onMain(() => { destroy(); }));

  bridge.register('webview.snapshot', (p?: { width?: number; quality?: number } | null) => {
    const o = snapOpts(p);
    return onMain(() => new Promise<{ jpeg: string; width: number; height: number }>((resolve, reject) => {
      if (!wv || wv.hidden) return reject(err('NATIVE_ERROR', 'webview.snapshot: not shown'));
      const cfg = WKSnapshotConfiguration.new();
      cfg.snapshotWidth = o.width / (UIScreen.mainScreen.scale || 1) as any; // points; the image comes at screen scale
      wv.takeSnapshotWithConfigurationCompletionHandler(cfg, (img: UIImage, e: NSError) => {
        const data = img && UIImageJPEGRepresentation(img, o.quality);
        if (!data) return reject(err('NATIVE_ERROR', `webview.snapshot: ${e?.localizedDescription || 'no image'}`));
        resolve({ jpeg: data.base64EncodedStringWithOptions(0 as any), width: Math.round(img.size.width * img.scale), height: Math.round(img.size.height * img.scale) });
      });
    }));
  });

  bridge.register('webview.cookies', (p: { cookies?: Cookie[] } | null) => {
    const list = cookieList(p);
    return onMain(() => new Promise<{ set: number }>((resolve) => {
      const jar = WKWebsiteDataStore.defaultDataStore().httpCookieStore;
      let left = list.length, set = 0;
      const done = () => { if (--left <= 0) resolve({ set }); };
      if (!left) return resolve({ set });
      for (const c of list) {
        const props = NSMutableDictionary.new<string, any>();
        props.setObjectForKey(c.name, NSHTTPCookieName);
        props.setObjectForKey(c.value ?? '', NSHTTPCookieValue);
        props.setObjectForKey(c.domain, NSHTTPCookieDomain);
        props.setObjectForKey(c.path || '/', NSHTTPCookiePath);
        if (c.secure) props.setObjectForKey('TRUE', NSHTTPCookieSecure);
        if (c.httpOnly) props.setObjectForKey('TRUE', 'HttpOnly'); // no public constant; the key CFNetwork reads
        if (c.expires) props.setObjectForKey(NSDate.dateWithTimeIntervalSince1970(c.expires), NSHTTPCookieExpires);
        if (c.sameSite === 'lax') props.setObjectForKey(NSHTTPCookieSameSiteLax, NSHTTPCookieSameSitePolicy);
        else if (c.sameSite === 'strict') props.setObjectForKey(NSHTTPCookieSameSiteStrict, NSHTTPCookieSameSitePolicy);
        const cookie = NSHTTPCookie.cookieWithProperties(props);
        if (!cookie) { console.warn(`[webview] cookie skipped (invalid): ${c.name} @ ${c.domain}`); done(); continue; }
        jar.setCookieCompletionHandler(cookie, () => { set++; done(); });
      }
    }));
  });
}

function registerAndroid(): void {
  let wv: any = null; // android.webkit.WebView
  let insets = { top: 0, bottom: 0 };
  let layoutListener: any = null;
  let host: any = null;
  let emitQueued = false;
  // NS caches extend() proxies by shape — build each client class ONCE; route to the single live overlay.
  let ViewClient: any, ChromeClient: any;

  const state = () => ({
    url: wv?.getUrl() ?? '',
    title: wv?.getTitle() ?? '',
    canGoBack: !!wv?.canGoBack(),
    canGoForward: !!wv?.canGoForward(),
    loading: !!wv && wv.getProgress() < 100,
  });
  const emitState = () => {
    if (emitQueued) return;
    emitQueued = true;
    setTimeout(() => { emitQueued = false; if (wv) bridge.emit('webview.state', state()); }, 0);
  };

  const activity = () => Application.android.foregroundActivity ?? Application.android.startActivity;
  const density = () => Utils.android.getApplicationContext().getResources().getDisplayMetrics().density || 1;
  const content = (): any => activity()?.findViewById(android.R.id.content); // FrameLayout

  /** Place the overlay over the app WebView's box, `top`/`bottom` CSS px inside it. */
  const layout = () => {
    const frame = content();
    if (!wv || !frame) return;
    const d = density();
    const fl = [0, 0], hl = [0, 0];
    frame.getLocationInWindow(fl);
    let boxTop = 0, boxBottom = 0;
    if (host) {
      host.getLocationInWindow(hl);
      boxTop = hl[1] - fl[1];
      boxBottom = frame.getHeight() - (boxTop + host.getHeight());
    }
    const lp = new android.widget.FrameLayout.LayoutParams(-1, -1);
    lp.topMargin = Math.max(0, Math.round(boxTop + insets.top * d));
    lp.bottomMargin = Math.max(0, Math.round(boxBottom + insets.bottom * d));
    wv.setLayoutParams(lp);
  };

  const load = (url: string) => {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw err('NATIVE_ERROR', `webview: invalid url ${url}`);
    wv.loadUrl(url);
  };

  const create = () => {
    const frame = content();
    if (!frame) throw err('NATIVE_ERROR', 'webview.open: no host view');
    host = bridge.getWebView()?.android ?? null;
    ViewClient ??= (android.webkit.WebViewClient as any).extend({
      onPageStarted() { emitState(); },
      onPageFinished() { emitState(); },
      doUpdateVisitedHistory() { emitState(); },
    });
    ChromeClient ??= (android.webkit.WebChromeClient as any).extend({
      onReceivedTitle() { emitState(); },
      onProgressChanged() { emitState(); },
      onPermissionRequest(request: any) { handleWebPermissionRequest(request); },
    });
    const view = new android.webkit.WebView(activity());
    const st = view.getSettings();
    st.setJavaScriptEnabled(true);
    st.setDomStorageEnabled(true);
    st.setMediaPlaybackRequiresUserGesture(false);
    st.setSupportMultipleWindows(false); // target=_blank / window.open load in place
    android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
    const client = new ViewClient(), chrome = new ChromeClient();
    view.setWebViewClient(client);
    view.setWebChromeClient(chrome);
    (view as any)._appwrapClients = [client, chrome]; // keep JS peers alive (NS GC doesn't see the native hold)
    const bg = host?.getBackground?.();
    if (bg instanceof android.graphics.drawable.ColorDrawable) view.setBackgroundColor(bg.getColor());
    if (SHELL_CONFIG.debug) android.webkit.WebView.setWebContentsDebuggingEnabled(true); // remote DevTools only in debug builds, never store builds
    wv = view;
    frame.addView(view);
    layout();
    if (host) {
      layoutListener = new android.view.View.OnLayoutChangeListener({ onLayoutChange() { layout(); } });
      host.addOnLayoutChangeListener(layoutListener);
    }
  };

  const destroy = () => {
    if (!wv) return;
    if (host && layoutListener) host.removeOnLayoutChangeListener(layoutListener);
    wv.stopLoading();
    wv.getParent()?.removeView(wv);
    wv.destroy();
    wv = null; host = null; layoutListener = null;
    android.webkit.CookieManager.getInstance().flush();
    bridge.emit('webview.closed', {});
  };

  const onMain = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve, reject) => Utils.dispatchToMainThread(() => {
      try { resolve(fn()); } catch (e) { reject(e); }
    }));
  const inset = (v?: number) => Math.max(0, Number(v) || 0);
  const setInsets = (top?: number, bottom?: number) => {
    if (top !== undefined) insets.top = inset(top);
    if (bottom !== undefined) insets.bottom = inset(bottom);
    layout();
  };
  const reveal = () => { wv.setVisibility(android.view.View.VISIBLE); wv.bringToFront(); };

  bridge.register('webview.open', ({ url, top, bottom }: { url: string; top?: number; bottom?: number }) => {
    const target = String(url ?? '');
    if (!target) throw err('NATIVE_ERROR', 'webview.open: empty url');
    return onMain(() => {
      if (!wv) { insets = { top: inset(top), bottom: inset(bottom) }; create(); }
      else setInsets(top, bottom);
      reveal();
      load(target);
      return state();
    });
  });

  bridge.register('webview.nav', ({ op, url }: { op: string; url?: string }) =>
    onMain(() => {
      if (!wv) throw err('NATIVE_ERROR', 'webview.nav: not open');
      if (op === 'back') { if (wv.canGoBack()) wv.goBack(); }
      else if (op === 'forward') { if (wv.canGoForward()) wv.goForward(); }
      else if (op === 'reload') wv.reload();
      else if (op === 'go') load(String(url ?? ''));
      else throw err('NATIVE_ERROR', `webview.nav: unknown op ${op}`);
      return state();
    })
  );

  bridge.register('webview.hide', () => onMain(() => { wv?.setVisibility(android.view.View.GONE); return { open: !!wv }; }));
  bridge.register('webview.show', (p?: { top?: number; bottom?: number } | null) => onMain(() => {
    if (wv) { setInsets(p?.top, p?.bottom); reveal(); }
    return { open: !!wv };
  }));
  bridge.register('webview.close', () => onMain(() => { destroy(); }));

  bridge.register('webview.snapshot', (p?: { width?: number; quality?: number } | null) => {
    const o = snapOpts(p);
    return onMain(() => {
      if (!wv || wv.getVisibility() !== android.view.View.VISIBLE || !wv.getWidth() || !wv.getHeight()) throw err('NATIVE_ERROR', 'webview.snapshot: not shown');
      const s = o.width / wv.getWidth(), h = Math.max(1, Math.round(wv.getHeight() * s));
      const bmp = android.graphics.Bitmap.createBitmap(o.width, h, android.graphics.Bitmap.Config.ARGB_8888);
      const c = new android.graphics.Canvas(bmp);
      c.scale(s, s);
      c.translate(-wv.getScrollX(), -wv.getScrollY()); // draw() paints from the content origin
      wv.draw(c);
      const out = new java.io.ByteArrayOutputStream();
      bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, Math.round(o.quality * 100), out);
      bmp.recycle();
      return { jpeg: android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP), width: o.width, height: h };
    });
  });

  bridge.register('webview.cookies', (p: { cookies?: Cookie[] } | null) => {
    const list = cookieList(p);
    return onMain(() => new Promise<{ set: number }>((resolve) => {
      const cm = android.webkit.CookieManager.getInstance();
      let left = list.length, set = 0;
      const done = () => { if (--left <= 0) { cm.flush(); resolve({ set }); } };
      if (!left) return resolve({ set });
      for (const c of list) {
        const path = c.path || '/', host = c.domain.replace(/^\./, '');
        const attrs = [`${c.name}=${c.value ?? ''}`, ...(c.domain.startsWith('.') ? [`Domain=${c.domain}`] : []), `Path=${path}`,
          ...(c.secure ? ['Secure'] : []), ...(c.httpOnly ? ['HttpOnly'] : []),
          ...(c.expires ? [`Expires=${new Date(c.expires * 1000).toUTCString()}`] : []),
          ...(c.sameSite ? [`SameSite=${c.sameSite}`] : [])];
        cm.setCookie(`${c.secure ? 'https' : 'http'}://${host}${path}`, attrs.join('; '),
          new android.webkit.ValueCallback<java.lang.Boolean>({ onReceiveValue: (ok) => { if (ok) set++; done(); } }));
      }
    }));
  });
}
