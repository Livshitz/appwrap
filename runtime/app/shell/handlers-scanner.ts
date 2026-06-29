import { Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { requestPermissions, startActivityForResult } from './android-helpers';

// `dispatch_get_main_queue()` is a C macro, NOT a bridged symbol — NativeScript can't see it
// ("is not defined" at runtime). `dispatch_queue_create` IS a real bridged libdispatch function;
// a dedicated serial queue is the correct delegate queue for AVCaptureMetadataOutput anyway.
declare function dispatch_queue_create(label: string, attr: any): any;
declare const com: any; // no NS types: third-party ZXing (com.google.zxing.integration.android.*)

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

// iOS metadata-output delegate. NativeScript uses the declared protocol to map the camelCase JS
// method to the colonated selector `captureOutput:didOutputMetadataObjects:fromConnection:`; with an
// empty protocols list it registers under the wrong selector and AVFoundation never calls it — the
// scanner opens but never decodes. The first decoded object is forwarded via the `onResult` instance
// field (assigned after `new()`), replacing the original closure capture.
// Built lazily INSIDE the iOS-only path (mirrors banner.ts): NSObject/AV* are iOS globals and this file
// is imported on Android too, so a top-level `@NativeClass extends NSObject` would crash at module load.
// any: runtime-built ObjC subclass holder; the class BODY stays fully typed.
let MetadataDelegate: any;
function metadataDelegateClass(): any {
  if (!MetadataDelegate) {
    @NativeClass()
    class MetadataDelegateImpl extends NSObject implements AVCaptureMetadataOutputObjectsDelegate {
      static ObjCProtocols = [AVCaptureMetadataOutputObjectsDelegate];
      onResult?: (obj: AVMetadataObject) => void;
      static new(): MetadataDelegateImpl {
        return <MetadataDelegateImpl>super.new();
      }
      captureOutputDidOutputMetadataObjectsFromConnection(
        _output: AVCaptureOutput,
        metadataObjects: NSArray<AVMetadataObject> | AVMetadataObject[],
        _connection: AVCaptureConnection
      ): void {
        const obj = (metadataObjects as NSArray<AVMetadataObject>)?.firstObject;
        if (obj) this.onResult?.(obj);
      }
    }
    MetadataDelegate = MetadataDelegateImpl;
  }
  return MetadataDelegate;
}

/**
 * Camera barcode / QR decoding. iOS: AVCaptureMetadataOutput in a full-screen capture VC presented
 * over the WebView; first machine-readable code → stop session, dismiss, resolve. Android: ZXing's
 * own capture Activity (zxing-android-embedded) launched via startActivityForResult.
 *
 * Contract: `scanner.scan` resolves `{ value, format, bounds? }` on first decode, or
 * `{ cancelled: true }` if the user dismisses (or `scanner.cancel` fires). It never rejects on a
 * plain cancel — only on a hard failure (no camera, permission denied at the OS level).
 */
export function registerScannerHandlers(): void {
  if (isIOS) registerIos();
  else if (isAndroid) registerAndroid();
}

/** Map our small enum → the platform metadata-object types. Empty/`all` = the full supported set. */
function iosFormatTypes(formats: any): string[] {
  const all = [AVMetadataObjectTypeQRCode, AVMetadataObjectTypeEAN13Code, AVMetadataObjectTypeCode128Code];
  const want = Array.isArray(formats) ? formats : formats ? [formats] : [];
  const sel = want.filter((f: string) => f && f !== 'all');
  if (!sel.length) return all;
  const map: Record<string, string> = {
    qr: AVMetadataObjectTypeQRCode,
    ean13: AVMetadataObjectTypeEAN13Code,
    code128: AVMetadataObjectTypeCode128Code,
  };
  return sel.map((f: string) => map[f]).filter(Boolean);
}

function iosFormatName(type: string): string {
  if (type === AVMetadataObjectTypeQRCode) return 'qr';
  if (type === AVMetadataObjectTypeEAN13Code) return 'ean13';
  if (type === AVMetadataObjectTypeCode128Code) return 'code128';
  return 'unknown';
}

function registerIos(): void {
  // Strong refs while the scanner is up — ARC would otherwise free the session/VC/delegate the moment
  // the JS locals fall out of scope, killing capture mid-stream (same hazard as handlers-oauth).
  let activeSession: any = null;
  let activeVC: any = null;
  let activeDelegate: any = null;
  let pending: { resolve: (v: any) => void } | null = null;

  const dismiss = () => {
    Utils.dispatchToMainThread(() => {
      try { activeSession?.stopRunning(); } catch { /* already stopped */ }
      activeVC?.dismissViewControllerAnimatedCompletion(true, null);
      activeSession = null;
      activeVC = null;
      activeDelegate = null;
    });
  };

  const settle = (value: any) => {
    const p = pending;
    pending = null;
    dismiss();
    // The metadata delegate now fires on a background serial queue; the bridge reply drives
    // WKWebView.evaluateJavaScript, which must run on the main thread — so hop back to resolve.
    Utils.dispatchToMainThread(() => p?.resolve(value));
  };

  bridge.register('scanner.cancel', () => { if (pending) settle({ cancelled: true }); });

  bridge.register('scanner.scan', (params: any) =>
    new Promise((resolve, reject) => {
      if (pending) { reject(err('NATIVE_ERROR', 'scanner.scan: a scan is already in progress')); return; }
      pending = { resolve };

      Utils.dispatchToMainThread(() => {
        try {
          const wantFront = params?.camera === 'front';
          const position = wantFront ? AVCaptureDevicePosition.Front : AVCaptureDevicePosition.Back;
          const discovery = AVCaptureDeviceDiscoverySession.discoverySessionWithDeviceTypesMediaTypePosition(
            [AVCaptureDeviceTypeBuiltInWideAngleCamera], AVMediaTypeVideo, position
          );
          const device = discovery?.devices?.firstObject ?? AVCaptureDevice.defaultDeviceWithMediaType(AVMediaTypeVideo);
          if (!device) { pending = null; reject(err('UNSUPPORTED', 'No camera available')); return; }

          const input = AVCaptureDeviceInput.deviceInputWithDeviceError(device, null);
          if (!input) { pending = null; reject(err('NATIVE_ERROR', 'Cannot open camera input')); return; }

          const session = AVCaptureSession.new();
          if (!session.canAddInput(input)) { pending = null; reject(err('NATIVE_ERROR', 'Cannot add camera input')); return; }
          session.addInput(input);

          const output = AVCaptureMetadataOutput.new();
          if (!session.canAddOutput(output)) { pending = null; reject(err('NATIVE_ERROR', 'Cannot add metadata output')); return; }
          session.addOutput(output);

          // Delegate fires on a dedicated serial queue (see dispatch_queue_create below); settle()
          // hops back to the main thread for the WKWebView bridge reply.
          const delegate = metadataDelegateClass().new();
          delegate.onResult = (obj: AVMetadataObject) => {
            if (!pending) return;
            const value = (obj as AVMetadataMachineReadableCodeObject).stringValue;
            if (value == null) return;
            settle({ value: String(value), format: iosFormatName(obj.type) });
          };
          activeDelegate = delegate;
          output.setMetadataObjectsDelegateQueue(activeDelegate, dispatch_queue_create('cc.livx.scanner.metadata', null));
          // metadataObjectTypes must be set AFTER addOutput (the available set is session-derived).
          // interop: JS string[] is accepted at runtime where NSArray<string> is declared.
          output.metadataObjectTypes = iosFormatTypes(params?.formats) as any;

          const vc = UIViewController.new();
          const preview = AVCaptureVideoPreviewLayer.layerWithSession(session);
          preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
          preview.frame = vc.view.bounds;
          vc.view.layer.addSublayer(preview);

          // Cancel button so the user can dismiss without a successful read.
          const btn = UIButton.buttonWithType(0 /* UIButtonTypeCustom */);
          btn.setTitleForState('Cancel', 0 /* UIControlStateNormal */);
          btn.frame = CGRectMake(16, 56, 100, 40);
          const Target = (NSObject as any).extend(
            { tap() { if (pending) settle({ cancelled: true }); } },
            { exposedMethods: { tap: { returns: interop.types.void } } }
          );
          activeVC = vc;
          (vc as any)._cancelTarget = Target.new(); // retain via the (also-retained) VC
          btn.addTargetActionForControlEvents((vc as any)._cancelTarget, 'tap', 1 << 6 /* TouchUpInside */);
          vc.view.addSubview(btn);

          activeSession = session;
          session.startRunning();

          const root = Utils.ios.getRootViewController();
          vc.modalPresentationStyle = 0; // fullScreen
          root.presentViewControllerAnimatedCompletion(vc, true, null);
        } catch (e: any) {
          pending = null;
          reject(err('NATIVE_ERROR', e?.message ?? 'scanner failed to start'));
        }
      });
    })
  );
}

function registerAndroid(): void {
  // ZXing-android-embedded ships its own capture Activity (CaptureActivity). We build the launch
  // Intent via IntentIntegrator, run it through startActivityForResult, and parse the result —
  // no hand-built Camera2 preview. IntentResult carries the decoded text + format name.
  const formatName = (zxingName: string): string => {
    const n = String(zxingName ?? '').toUpperCase();
    if (n === 'QR_CODE') return 'qr';
    if (n === 'EAN_13') return 'ean13';
    if (n === 'CODE_128') return 'code128';
    return 'unknown';
  };

  bridge.register('scanner.cancel', () => {
    // The ZXing capture Activity owns its own back/up dismissal; there's no in-process handle to it
    // once launched. Cancel is honored by the user pressing back, which returns a null-contents result.
  });

  bridge.register('scanner.scan', async (params: any) => {
    const granted = await requestPermissions(['android.permission.CAMERA']);
    if (!granted) throw err('DENIED', 'Camera permission denied');

    const activity = Utils.android.getCurrentActivity?.() ?? undefined;
    const integrator = activity
      ? new com.google.zxing.integration.android.IntentIntegrator(activity)
      : new com.google.zxing.integration.android.IntentIntegrator(Utils.android.getApplicationContext());

    // Restrict to our format set (or all). IntentIntegrator names match ZXing BarcodeFormat names.
    const want = Array.isArray(params?.formats) ? params.formats : params?.formats ? [params.formats] : [];
    const sel = want.filter((f: string) => f && f !== 'all');
    if (sel.length) {
      const map: Record<string, string> = { qr: 'QR_CODE', ean13: 'EAN_13', code128: 'CODE_128' };
      const list = new java.util.ArrayList();
      sel.forEach((f: string) => { const z = map[f]; if (z) list.add(z); });
      if (list.size()) integrator.setDesiredBarcodeFormats(list);
    }
    integrator.setBeepEnabled(false);
    integrator.setOrientationLocked(false);

    const intent = integrator.createScanIntent();
    const { resultCode, intent: data } = await startActivityForResult(intent);

    const result = com.google.zxing.integration.android.IntentIntegrator.parseActivityResult(resultCode, data);
    const contents = result?.getContents?.();
    if (contents == null) return { cancelled: true }; // user backed out
    return { value: String(contents), format: formatName(result.getFormatName?.()) };
  });
}
