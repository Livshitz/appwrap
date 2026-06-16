import { Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

// AuthenticationServices globals (NS auto-links the framework via metadata when referenced).
declare const ASWebAuthenticationSession: any;
declare const ASWebAuthenticationPresentationContextProviding: any;

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

// Keep strong refs while the sheet is up — ARC frees the session + its context provider the moment
// the JS locals fall out of scope, which silently cancels the flow mid-handshake.
let activeSession: any = null;
let activeProvider: any = null;

/**
 * System-browser OAuth (iOS ASWebAuthenticationSession). Runs the provider's auth page in the
 * OS-shared, policy-compliant browser and returns the redirect callback URL to JS — so Google et al.
 * don't reject it as an embedded WebView (403 disallowed_useragent). Provider-agnostic: the PWA builds
 * the auth URL + does token exchange; this only opens the browser and hands back the callback.
 */
export function registerOAuthHandlers(): void {
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
            (callbackURL: any, error: any) => {
              activeSession = null;
              activeProvider = null;
              if (error) {
                // ASWebAuthenticationSessionErrorCodeCanceledLogin === 1 (user dismissed the sheet).
                const code = error.code === 1 ? 'CANCELLED' : 'NATIVE_ERROR';
                reject(err(code, error.localizedDescription ?? 'oauth failed'));
                return;
              }
              resolve({ url: callbackURL ? String(callbackURL.absoluteString) : '' });
            }
          );

          const ProviderClass = (NSObject as any).extend(
            {
              presentationAnchorForWebAuthenticationSession(_session: any): any {
                return (
                  Utils.ios.getRootViewController()?.view?.window ??
                  UIApplication.sharedApplication.keyWindow
                );
              },
            },
            { protocols: [ASWebAuthenticationPresentationContextProviding] }
          );
          activeProvider = ProviderClass.new();
          session.presentationContextProvider = activeProvider;
          session.prefersEphemeralWebBrowserSession = !!ephemeral;
          activeSession = session;
          session.start();
        });
      })
  );
}
