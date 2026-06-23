import Foundation
import StoreKit
import UIKit

// StoreKit 2's `AppStore.showManageSubscriptions(in:)` is Swift-only + async, so it can't be reached
// from the ObjC bridge NativeScript uses. This @objc wrapper bridges the async call to a completion
// callback (NativeScript can't await Swift async) and runs it on the main actor against the active
// foreground UIWindowScene. Shipped via the billing module's nativeSrc → compiled only when `billing`
// is active. iOS 15+ (StoreKit 2); the JS layer guards the deep-link fallback.
//
// NOTE: this sheet presents/dismisses WITHOUT the app scene leaving foregroundActive, so iOS fires no
// resumeEvent and leaves an orphaned interactive tracking-window above ours that swallows touches. The
// JS handler recovers from THIS completion via `CustomWebView.recoverAfterNativeSurface()` (shared with
// every other native surface) — so this shim only needs to present + report success/failure.
@objc(AppwrapManageSubscriptions)
public final class AppwrapManageSubscriptions: NSObject {
  // completion(nil) on success; completion(message) on failure. Always invoked on the main thread so
  // the NS JS continuation (which then drives the WebView recovery) resumes on the UI thread.
  @objc public static func present(_ completion: @escaping (String?) -> Void) {
    guard #available(iOS 15.0, *) else {
      completion("StoreKit 2 manage-subscriptions sheet requires iOS 15+")
      return
    }
    Task { @MainActor in
      guard let scene = AppwrapManageSubscriptions.activeWindowScene() else {
        completion("No active UIWindowScene to present the subscriptions sheet")
        return
      }
      do {
        try await AppStore.showManageSubscriptions(in: scene)
        completion(nil)
      } catch {
        completion(error.localizedDescription)
      }
    }
  }

  // The foreground-active window scene (the one allowed to present UI). Falls back to any connected
  // window scene so a not-yet-foreground launch still finds a presenter.
  @MainActor private static func activeWindowScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
  }
}
