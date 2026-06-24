import { Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { sha256Hex } from './sha256';

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

// Keep strong refs while the system sheet is up — ARC frees the controller + its delegate + context
// provider the moment the JS locals fall out of scope, which silently cancels the flow mid-handshake
// (same lesson as handlers-oauth.ts `activeSession`/`activeProvider`).
let activeController: ASAuthorizationController | null = null;
let activeDelegate: AppleSignInDelegate | null = null;
let activeProvider: AppleSignInContextProvider | null = null;

@NativeClass()
class AppleSignInContextProvider extends NSObject implements ASAuthorizationControllerPresentationContextProviding {
  static ObjCProtocols = [ASAuthorizationControllerPresentationContextProviding];
  static new(): AppleSignInContextProvider {
    return <AppleSignInContextProvider>super.new();
  }
  presentationAnchorForAuthorizationController(_controller: ASAuthorizationController): UIWindow {
    return (
      Utils.ios.getRootViewController()?.view?.window ??
      UIApplication.sharedApplication.keyWindow
    );
  }
}

/** Decode an Apple-returned NSData JWT/code blob into a UTF-8 string (identityToken/authorizationCode). */
function dataToUtf8(data: NSData | null): string | undefined {
  if (!data) return undefined;
  const s = NSString.alloc().initWithDataEncoding(data, NSUTF8StringEncoding);
  return s ? String(s) : undefined;
}

@NativeClass()
class AppleSignInDelegate extends NSObject implements ASAuthorizationControllerDelegate {
  static ObjCProtocols = [ASAuthorizationControllerDelegate];
  // Per-call settlement (set right after `.new()`). The shared `settle` clears the ARC refs + recovers
  // the WebView before resolving/rejecting, so it runs exactly once per flow.
  rawNonce = '';
  settle!: (fn: () => void) => void;
  resolve!: (v: unknown) => void;
  reject!: (e: unknown) => void;
  static new(): AppleSignInDelegate {
    return <AppleSignInDelegate>super.new();
  }

  authorizationControllerDidCompleteWithAuthorization(
    _controller: ASAuthorizationController,
    authorization: ASAuthorization
  ): void {
    const cred = authorization.credential as ASAuthorizationAppleIDCredential;
    const identityToken = dataToUtf8(cred.identityToken ?? null);
    if (!identityToken) {
      this.settle(() => this.reject(err('NATIVE_ERROR', 'appleSignIn: Apple returned no identityToken')));
      return;
    }
    const authorizationCode = dataToUtf8(cred.authorizationCode ?? null);

    // First-authorization-only profile. Apple omits name/email on subsequent sign-ins per Apple ID.
    let name: { givenName?: string; familyName?: string; displayName?: string } | undefined;
    if (cred.fullName) {
      const givenName = cred.fullName.givenName || undefined;
      const familyName = cred.fullName.familyName || undefined;
      // OS-composed display name (locale-aware) — convenience; the consumer can also build its own.
      const composed = NSPersonNameComponentsFormatter.localizedStringFromPersonNameComponentsStyleOptions(
        cred.fullName,
        NSPersonNameComponentsFormatterStyle.Default,
        0 as NSPersonNameComponentsFormatterOptions
      );
      const displayName = (composed && String(composed)) || undefined;
      if (givenName || familyName || displayName) name = { givenName, familyName, displayName };
    }
    const email = cred.email || undefined;
    const user = name || email ? { ...(name ? { name } : {}), ...(email ? { email } : {}) } : undefined;

    this.settle(() =>
      this.resolve({ identityToken, authorizationCode, nonce: this.rawNonce, ...(user ? { user } : {}) })
    );
  }

  authorizationControllerDidCompleteWithError(_controller: ASAuthorizationController, error: NSError): void {
    // ASAuthorizationError.Canceled === 1001 (user dismissed the sheet) → resolve cancelled, never throw.
    if (error.code === ASAuthorizationError.Canceled) {
      this.settle(() => this.resolve({ cancelled: true }));
      return;
    }
    this.settle(() => this.reject(err('NATIVE_ERROR', error.localizedDescription ?? 'appleSignIn failed')));
  }
}

/**
 * Native Sign in with Apple (iOS, `appleSignIn` module). Strippable own-handler file (registered only
 * when the module is active) — a build without it compiles NO ASAuthorization code and stamps no
 * entitlement. Presents `ASAuthorizationController` (the system account sheet) and returns the Apple
 * `identityToken` + raw nonce DIRECTLY to JS, so the PWA can do `signInWithCredential` on Firebase.
 *
 * The caller passes a RAW nonce; we send SHA256(nonce) to Apple (Apple binds the id_token to the hash)
 * and return the raw nonce unchanged so the web app hands `rawNonce` to Firebase.
 *
 * Name/email come back ONLY on the first authorization per Apple ID — we relay them when present.
 * Cancel resolves `{ cancelled: true }` (never throws), matching the scanner/oauth contract.
 *
 * iOS-only: the capability is gated `ios:true`/`android:false`, so the kit short-circuits off iOS
 * before reaching the bridge. The isIOS guard is defence-in-depth.
 *
 * DEVICE-VERIFIED (iPhone 13 Pro Max, 2026-06-24, hello-pwa under paid team RDYDSWE9RB): the native
 * ASAuthorization sheet presented, returned a real Apple-signed identityToken (JWT) + the raw nonce +
 * first-auth user email, and dismissed without freezing (recoverAfterNativeSurface held). The
 * com.apple.developer.applesignin entitlement signs only on a paid team — the free personal team can't
 * hold the Sign-in-with-Apple capability (same class as push aps-environment).
 */
export function registerAppleSignInHandlers(): void {
  if (!isIOS) return;

  bridge.register(
    'appleSignIn.signIn',
    ({ nonce, scopes }: { nonce: string; scopes?: Array<'name' | 'email'> }) =>
      new Promise((resolve, reject) => {
        const rawNonce = String(nonce ?? '');
        if (!rawNonce) { reject(err('NATIVE_ERROR', 'appleSignIn.signIn: empty nonce')); return; }
        const want = new Set(scopes ?? ['name', 'email']);

        Utils.dispatchToMainThread(() => {
          try {
            const provider = ASAuthorizationAppleIDProvider.alloc().init();
            const request = provider.createRequest();
            // Apple binds the returned id_token to SHA256(nonce); we hand back the RAW nonce to JS.
            request.nonce = sha256Hex(rawNonce);
            const scopeList: string[] = [];
            if (want.has('name')) scopeList.push(ASAuthorizationScopeFullName);
            if (want.has('email')) scopeList.push(ASAuthorizationScopeEmail);
            request.requestedScopes = NSArray.arrayWithArray<string>(scopeList as any);

            const settle = (fn: () => void) => {
              activeController = null;
              activeDelegate = null;
              activeProvider = null;
              // An ASAuthorization sheet can leave the WebView frozen on dismiss like the other native
              // surfaces — recover from its completion (shared framework fix).
              bridge.getWebView()?.recoverAfterNativeSurface();
              fn();
            };

            const delegate = AppleSignInDelegate.new();
            delegate.rawNonce = rawNonce;
            delegate.settle = settle;
            delegate.resolve = resolve;
            delegate.reject = reject;

            const controller = ASAuthorizationController.alloc().initWithAuthorizationRequests(
              NSArray.arrayWithObject<ASAuthorizationRequest>(request)
            );
            activeDelegate = delegate;
            activeProvider = AppleSignInContextProvider.new();
            controller.delegate = delegate;
            controller.presentationContextProvider = activeProvider;
            activeController = controller;
            controller.performRequests();
          } catch (e: any) {
            activeController = null;
            activeDelegate = null;
            activeProvider = null;
            reject(err('NATIVE_ERROR', e?.message ?? 'appleSignIn failed to start'));
          }
        });
      })
  );
}
