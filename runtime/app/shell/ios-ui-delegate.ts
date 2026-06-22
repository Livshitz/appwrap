import { Utils } from '@nativescript/core';

/**
 * WKUIDelegate for the shell WebView. Two jobs:
 *  1. Auto-grant getUserMedia (mic/camera) for our own origin — the native app
 *     already holds the OS-level permission (Info.plist), so re-prompting per
 *     web-origin is friction. iOS 15+ only; older builds fall back to WebKit's
 *     own prompt.
 *  2. Re-implement the JS alert/confirm/prompt panels — WKWebView drops them
 *     silently without a UIDelegate, which would break any PWA calling
 *     window.alert/confirm/prompt.
 *
 * Returns a retained delegate instance (the WKWebView holds uiDelegate weakly).
 */
@NativeClass()
class AppwrapUiDelegate extends NSObject implements WKUIDelegate {
  static ObjCProtocols = [WKUIDelegate];
  static new(): AppwrapUiDelegate {
    return <AppwrapUiDelegate>super.new();
  }

  // iOS 15+: WKUIDelegate media capture permission.
  webViewRequestMediaCapturePermissionForOriginInitiatedByFrameTypeDecisionHandler(
    _webView: WKWebView,
    _origin: WKSecurityOrigin,
    _frame: WKFrameInfo,
    _type: WKMediaCaptureType,
    decisionHandler: (decision: WKPermissionDecision) => void
  ): void {
    // WKPermissionDecision.Grant === 1 — silently grant (the app already holds the
    // OS-level mic/camera permission; media.ensurePermission established TCC).
    // NOTE: this only ever sees capabilities the build DECLARED — a request for an
    // UNDECLARED capability is rejected upstream in JS (mediaCaptureGuardJs), because
    // WebKit asks TCC to authorize the device AROUND this callback and a missing usage
    // string is a hard process-kill a native `deny` here cannot prevent. So denying
    // here is pointless for the crash; the real guard must be (and is) at the JS layer.
    decisionHandler(WKPermissionDecision.Grant);
  }

  // Preserve the behavior NS's own UIDelegate gave us (we fully replace it):
  // target=_blank / window.open has no new window in a shell → load it in place.
  webViewCreateWebViewWithConfigurationForNavigationActionWindowFeatures(
    webView: WKWebView,
    _configuration: WKWebViewConfiguration,
    navigationAction: WKNavigationAction,
    _windowFeatures: WKWindowFeatures
  ): WKWebView {
    const frame = navigationAction.targetFrame;
    if (!frame || !frame.mainFrame) webView.loadRequest(navigationAction.request);
    return null as unknown as WKWebView;
  }

  webViewRunJavaScriptAlertPanelWithMessageInitiatedByFrameCompletionHandler(
    _webView: WKWebView,
    message: string,
    _frame: WKFrameInfo,
    completionHandler: () => void
  ): void {
    Utils.dispatchToMainThread(() => {
      const alert = UIAlertController.alertControllerWithTitleMessagePreferredStyle(
        null as unknown as string,
        String(message ?? ''),
        UIAlertControllerStyle.Alert
      );
      alert.addAction(
        UIAlertAction.actionWithTitleStyleHandler('OK', UIAlertActionStyle.Default, () => completionHandler())
      );
      present(alert);
    });
  }

  webViewRunJavaScriptConfirmPanelWithMessageInitiatedByFrameCompletionHandler(
    _webView: WKWebView,
    message: string,
    _frame: WKFrameInfo,
    completionHandler: (ok: boolean) => void
  ): void {
    Utils.dispatchToMainThread(() => {
      const alert = UIAlertController.alertControllerWithTitleMessagePreferredStyle(
        null as unknown as string,
        String(message ?? ''),
        UIAlertControllerStyle.Alert
      );
      alert.addAction(
        UIAlertAction.actionWithTitleStyleHandler('Cancel', UIAlertActionStyle.Cancel, () =>
          completionHandler(false)
        )
      );
      alert.addAction(
        UIAlertAction.actionWithTitleStyleHandler('OK', UIAlertActionStyle.Default, () => completionHandler(true))
      );
      present(alert);
    });
  }

  webViewRunJavaScriptTextInputPanelWithPromptDefaultTextInitiatedByFrameCompletionHandler(
    _webView: WKWebView,
    prompt: string,
    defaultText: string,
    _frame: WKFrameInfo,
    completionHandler: (text: string) => void
  ): void {
    Utils.dispatchToMainThread(() => {
      const alert = UIAlertController.alertControllerWithTitleMessagePreferredStyle(
        null as unknown as string,
        String(prompt ?? ''),
        UIAlertControllerStyle.Alert
      );
      let field: UITextField | null = null;
      alert.addTextFieldWithConfigurationHandler((tf: UITextField) => {
        tf.text = String(defaultText ?? '');
        field = tf;
      });
      alert.addAction(
        UIAlertAction.actionWithTitleStyleHandler('Cancel', UIAlertActionStyle.Cancel, () =>
          completionHandler(null as unknown as string)
        )
      );
      alert.addAction(
        UIAlertAction.actionWithTitleStyleHandler('OK', UIAlertActionStyle.Default, () =>
          completionHandler(field ? String(field.text ?? '') : '')
        )
      );
      present(alert);
    });
  }
}

export function createUiDelegate(): WKUIDelegate {
  return AppwrapUiDelegate.new();
}

function present(alert: UIAlertController): void {
  Utils.ios.getRootViewController().presentViewControllerAnimatedCompletion(alert, true, null);
}
