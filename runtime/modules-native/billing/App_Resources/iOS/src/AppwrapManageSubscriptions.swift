import Foundation
import StoreKit
import UIKit

// StoreKit 2's `AppStore.showManageSubscriptions(in:)` is Swift-only + async, so it can't be reached
// from the ObjC bridge NativeScript uses. This @objc wrapper bridges the async call to a completion
// callback (NativeScript can't await Swift async) and runs it on the main actor against the active
// foreground UIWindowScene. Shipped via the billing module's nativeSrc → compiled into the app target
// only when `billing` is active. iOS 15+ (StoreKit 2); the JS layer guards the deep-link fallback.
@objc(AppwrapManageSubscriptions)
public final class AppwrapManageSubscriptions: NSObject {
  // completion(nil) on success; completion(message) on failure. Always invoked on the main thread
  // so the NativeScript JS continuation (and WebView response delivery) resumes on the UI thread.
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
  // window scene so a not-yet-foregroundActive launch still finds a presenter.
  @MainActor private static func activeWindowScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
  }
}
