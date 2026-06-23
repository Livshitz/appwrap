import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { setDeepLinkInterceptor } from './events';

declare const androidx: any; // no NS types: androidx

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

// Keep strong refs while the sheet is up — ARC frees the session + its context provider the moment
// the JS locals fall out of scope, which silently cancels the flow mid-handshake.
let activeSession: ASWebAuthenticationSession | null = null;
let activeProvider: ASWebAuthenticationPresentationContextProviding | null = null;

@NativeClass()
class OAuthPresentationContextProvider extends NSObject implements ASWebAuthenticationPresentationContextProviding {
  static ObjCProtocols = [ASWebAuthenticationPresentationContextProviding];
  static new(): OAuthPresentationContextProvider {
    return <OAuthPresentationContextProvider>super.new();
  }
  presentationAnchorForWebAuthenticationSession(_session: ASWebAuthenticationSession): UIWindow {
    return (
      Utils.ios.getRootViewController()?.view?.window ??
      UIApplication.sharedApplication.keyWindow
    );
  }
}

/**
 * System-browser OAuth (iOS ASWebAuthenticationSession). Runs the provider's auth page in the
 * OS-shared, policy-compliant browser and returns the redirect callback URL to JS — so Google et al.
 * don't reject it as an embedded WebView (403 disallowed_useragent). Provider-agnostic: the PWA builds
 * the auth URL + does token exchange; this only opens the browser and hands back the callback.
 */
export function registerOAuthHandlers(): void {
  if (isAndroid) { registerAndroid(); return; }
  if (!isIOS) return;

  bridge.register(
    'oauth.authorize',
    ({ url, callbackScheme, ephemeral }: { url: string; callbackScheme: string; ephemeral?: boolean }) =>
      new Promise((resolve, reject) => {
        const target = String(url ?? '');
        const scheme = String(callbackScheme ?? '');
        if (!target) { reject(err('NATIVE_ERROR', 'oauth.authorize: empty url')); return; }
        if (!scheme) { reject(err('NATIVE_ERROR', 'oauth.authorize: empty callbackScheme')); return; }

        Utils.dispatchToMainThread(() => {
          const session = ASWebAuthenticationSession.alloc().initWithURLCallbackURLSchemeCompletionHandler(
            NSURL.URLWithString(target),
            scheme,
            (callbackURL: NSURL, error: NSError) => {
              activeSession = null;
              activeProvider = null;
              // ASWebAuthenticationSession can leave the WebView frozen on dismiss the same way the
              // StoreKit sheet does (orphaned tracking window / no resume) — recover from its completion.
              bridge.getWebView()?.recoverAfterNativeSurface();
              if (error) {
                // ASWebAuthenticationSessionErrorCodeCanceledLogin === 1 (user dismissed the sheet).
                const code = error.code === 1 ? 'CANCELLED' : 'NATIVE_ERROR';
                reject(err(code, error.localizedDescription ?? 'oauth failed'));
                return;
              }
              resolve({ url: callbackURL ? String(callbackURL.absoluteString) : '' });
            }
          );

          activeProvider = OAuthPresentationContextProvider.new();
          session.presentationContextProvider = activeProvider;
          session.prefersEphemeralWebBrowserSession = !!ephemeral;
          activeSession = session;
          session.start();
        });
      })
  );
}

/**
 * Android: launch the auth URL in a Chrome Custom Tab. Unlike iOS ASWebAuthenticationSession, a
 * Custom Tab does NOT auto-close on the provider redirect — the redirect to `callbackScheme://…`
 * re-launches our (singleTask) activity as a VIEW intent, which the shell's existing deep-link path
 * (events.wireAndroidDeepLinks → onDeepLink) already surfaces. We register a deep-link interceptor
 * that matches the pending callbackScheme, swallows that URL (it's OAuth plumbing, not an app deep
 * link), and resolves the pending authorize() with the same { url } shape the iOS path returns.
 *
 * Cancel contract (matches iOS user-dismiss → CANCELLED): Custom Tabs gives no dismissal callback, so
 * we infer cancellation on app.resume — if the app comes back to the foreground after the tab opened
 * and NO matching redirect arrived within a short grace window, the user backed out → reject CANCELLED.
 *
 * DEVICE-UNVERIFIED (any-typed FFI, no device run this session): the CustomTabsIntent launch + the
 * redirect→deep-link round-trip + the resume-based cancel inference. Compile-clean only.
 */
function registerAndroid(): void {
  // Single in-flight authorize at a time (mirrors the iOS single-session model).
  let pending:
    | { scheme: string; resolve: (v: any) => void; reject: (e: any) => void; settled: boolean; resumeOff: () => void }
    | null = null;

  const finish = (fn: () => void) => {
    if (!pending || pending.settled) return;
    pending.settled = true;
    pending.resumeOff();
    const p = pending;
    pending = null;
    fn.call(p);
  };

  // First refusal on every inbound deep link: consume the one that matches the pending callbackScheme.
  setDeepLinkInterceptor((url: string): boolean => {
    if (!pending || pending.settled) return false;
    const scheme = pending.scheme;
    if (!scheme || !String(url ?? '').toLowerCase().startsWith(scheme.toLowerCase() + ':')) return false;
    finish(function (this: any) { this.resolve({ url: String(url) }); });
    return true; // swallow — internal OAuth callback, not an app deep link
  });

  bridge.register(
    'oauth.authorize',
    ({ url, callbackScheme, ephemeral }: { url: string; callbackScheme: string; ephemeral?: boolean }) =>
      new Promise((resolve, reject) => {
        const target = String(url ?? '');
        const scheme = String(callbackScheme ?? '');
        if (!target) { reject(err('NATIVE_ERROR', 'oauth.authorize: empty url')); return; }
        if (!scheme) { reject(err('NATIVE_ERROR', 'oauth.authorize: empty callbackScheme')); return; }
        if (pending && !pending.settled) { reject(err('NATIVE_ERROR', 'oauth.authorize: a flow is already in progress')); return; }

        Utils.dispatchToMainThread(() => {
          try {
            const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
            if (!activity) { reject(err('NATIVE_ERROR', 'oauth.authorize: no foreground activity')); return; }

            // Cancel inference: the tab launch will background us; the FIRST resume afterwards means
            // the user is back in our app. If no redirect consumed the flow by then (+grace), it's a
            // user-cancel. A small delay lets a redirect that arrives in the same resume win the race.
            let launched = false;
            const onResume = () => {
              if (!launched || !pending || pending.settled) return;
              setTimeout(() => finish(function (this: any) { this.reject(err('CANCELLED', 'oauth cancelled')); }), 400);
            };
            Application.on(Application.resumeEvent, onResume);
            const resumeOff = () => Application.off(Application.resumeEvent, onResume);
            pending = { scheme, resolve, reject, settled: false, resumeOff };

            const builder = new androidx.browser.customtabs.CustomTabsIntent.Builder();
            // `ephemeral` (fresh login) → don't share the persisted browser session. Custom Tabs has
            // no per-launch incognito API; the closest honest knob is disabling the recents/share
            // surface so the auth page isn't trivially resumable. Cookie isolation isn't guaranteed.
            if (ephemeral) builder.setShareState(androidx.browser.customtabs.CustomTabsIntent.SHARE_STATE_OFF);
            const tabs = builder.build();
            // No extra intent flags: the `callbackScheme://…` redirect re-launches our singleTask
            // activity to the front (consumed by the deep-link interceptor), leaving the tab behind it.
            tabs.launchUrl(activity, android.net.Uri.parse(target));
            launched = true;
          } catch (e: any) {
            const fail = err('NATIVE_ERROR', e?.message ?? 'oauth failed to start');
            if (pending && !pending.settled) finish(function (this: any) { this.reject(fail); });
            else reject(fail); // failed before `pending` was wired
          }
        });
      })
  );
}
