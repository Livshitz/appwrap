import Foundation
import StoreKit
import UIKit

// StoreKit 2's `AppStore.showManageSubscriptions(in:)` is Swift-only + async, so it can't be reached
// from the ObjC bridge NativeScript uses. This @objc wrapper bridges the async call to a completion
// callback (NativeScript can't await Swift async) and runs it on the main actor against the active
// foreground UIWindowScene. Shipped via the billing module's nativeSrc → compiled into the app target
// only when `billing` is active. iOS 15+ (StoreKit 2); the JS layer guards the deep-link fallback.
//
// THE FREEZE IT FIXES: showManageSubscriptions(in:) presents/dismisses WITHOUT the app scene ever
// leaving foregroundActive (verified: zero app-lifecycle events fire across present→dismiss), so (a)
// the OS never fires a resume the WebView could wake on, and (b) the dismissal leaves an orphaned
// interactive UITrackingElementWindow at windowLevel 1 ABOVE our app window that swallows every touch —
// the app underneath stays alive but unresponsive ("frozen for minutes" until iOS reaps the window).
// We recover explicitly from THIS completion (the only thing that fires): after letting the dismissal
// settle, neutralise any stray above-our-main window (uie=false + hide) and re-key our window. The JS
// layer additionally drives the WebView's own resume (wakeWebContent) since no native resume arrives.
@objc(AppwrapManageSubscriptions)
public final class AppwrapManageSubscriptions: NSObject {
  // completion(error, diagnostic): error nil on success / message on failure; diagnostic is a
  // before/after window-hierarchy dump (DEBUG aid) the JS layer logs to the file sink. Always on main.
  @objc public static func present(_ completion: @escaping (String?, String?) -> Void) {
    guard #available(iOS 15.0, *) else {
      completion("StoreKit 2 manage-subscriptions sheet requires iOS 15+", nil)
      return
    }
    Task { @MainActor in
      guard let scene = AppwrapManageSubscriptions.activeWindowScene() else {
        completion("No active UIWindowScene to present the subscriptions sheet", nil)
        return
      }
      var err: String? = nil
      do {
        try await AppStore.showManageSubscriptions(in: scene)
      } catch {
        err = error.localizedDescription
      }
      let before = AppwrapManageSubscriptions.dump(scene, tag: "BEFORE")
      // The await can return before the dismissal animation finishes finalizing the orphan tracking
      // window — settle first, then neutralise it (hiding at completion-time was too early to stick).
      try? await Task.sleep(nanoseconds: 350_000_000)
      let after = AppwrapManageSubscriptions.recover(scene)
      completion(err, before + "\n" + after)
    }
  }

  // Read-only dump of the scene's windows (+ presented-VC chain, key/interaction flags) for diagnosis.
  @available(iOS 15.0, *)
  @MainActor private static func dump(_ scene: UIWindowScene, tag: String) -> String {
    var lines: [String] = ["\(tag): windows=\(scene.windows.count) keyWin=\(scene.keyWindow.map { ptr($0) } ?? "nil")"]
    for (i, w) in scene.windows.enumerated() {
      var presented: [String] = []
      var vc = w.rootViewController
      while let p = vc?.presentedViewController { presented.append(String(describing: type(of: p))); vc = p }
      lines.append("  [\(i)] \(ptr(w)) level=\(w.windowLevel.rawValue) key=\(w.isKeyWindow) hidden=\(w.isHidden) uie=\(w.isUserInteractionEnabled) root=\(w.rootViewController.map { String(describing: type(of: $0)) } ?? "nil") presented=\(presented.isEmpty ? "none" : presented.joined(separator: ">"))")
    }
    return lines.joined(separator: "\n")
  }

  // Neutralise any window sitting ABOVE our main app window (touch-stealer), dismiss a lingering
  // presented controller, and re-assert our main window as key. Returns the post-recovery dump.
  @available(iOS 15.0, *)
  @MainActor private static func recover(_ scene: UIWindowScene) -> String {
    var lines: [String] = []
    let main = scene.windows
      .filter { !$0.isHidden && $0.rootViewController != nil }
      .min { $0.windowLevel.rawValue < $1.windowLevel.rawValue }
    for (i, w) in scene.windows.enumerated() {
      if let presented = w.rootViewController?.presentedViewController {
        presented.dismiss(animated: false)
        lines.append("  recover: dismissed \(String(describing: type(of: presented))) on win[\(i)]")
      }
      if let m = main, w !== m, w.windowLevel.rawValue >= m.windowLevel.rawValue, w.windowLevel.rawValue > 0 {
        // Pass touches THROUGH to our app window below, and take it out of the hierarchy.
        w.isUserInteractionEnabled = false
        w.isHidden = true
        lines.append("  recover: neutralised win[\(i)] level=\(w.windowLevel.rawValue) root=\(w.rootViewController.map { String(describing: type(of: $0)) } ?? "nil")")
      }
    }
    if let m = main { m.makeKeyAndVisible(); lines.append("  recover: re-keyed main") }
    return AppwrapManageSubscriptions.dump(scene, tag: "AFTER-RECOVER") + "\n" + lines.joined(separator: "\n")
  }

  @MainActor private static func ptr(_ w: UIWindow) -> String {
    return "UIWindow<\(UInt(bitPattern: ObjectIdentifier(w).hashValue) & 0xffffff)>"
  }

  // The foreground-active window scene (the one allowed to present UI). Falls back to any connected
  // window scene so a not-yet-foreground launch still finds a presenter.
  @MainActor private static func activeWindowScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
  }
}
