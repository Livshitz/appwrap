import type { NativeKit } from '../core/NativeKit';

/** Symbologies the scanner can decode. `'all'` (default) accepts every supported format. */
export type ScanFormat = 'qr' | 'ean13' | 'code128' | 'all';

/** A successfully decoded code. */
export interface ScanResult {
  /** Decoded payload (the string the barcode/QR encodes). */
  value: string;
  /** Detected symbology — one of {@link ScanFormat} minus `'all'`, or `'unknown'`. */
  format: ScanFormat | 'unknown';
  /** Bounding box of the code in the camera preview (CSS px), when the platform reports it. */
  bounds?: { x: number; y: number; width: number; height: number };
}

/** Scan resolved without a code because the user dismissed the scanner. */
export interface ScanCancelled {
  cancelled: true;
}

export interface ScanOptions {
  /** Symbology filter — a single format or a list. Omit / `'all'` = any supported code. */
  formats?: ScanFormat | ScanFormat[];
  /** Which camera to open. Default `'back'`. */
  camera?: 'back' | 'front';
}

/** True when a {@link ScanResult.value} is present (not the cancelled shape). */
export function isScanResult(r: ScanResult | ScanCancelled): r is ScanResult {
  return (r as ScanCancelled).cancelled !== true;
}

/**
 * Camera barcode / QR decoding — ONE API across platforms.
 *
 * {@link scan} opens a native full-screen capture UI, returns the FIRST decoded code, then
 * auto-dismisses. If the user dismisses it first, it resolves to `{ cancelled: true }` (NOT a
 * rejection) — branch with {@link isScanResult}. {@link cancel} dismisses an in-progress scan
 * programmatically, which makes that same pending {@link scan} resolve `{ cancelled: true }`.
 *
 * Native (iOS `AVCaptureMetadataOutput`, Android ZXing capture Activity) reports
 * `capability === 'native'`. Web maps to the `BarcodeDetector` API where present (Chrome/Android
 * → `'web'`); where absent (Safari/Firefox today) it's `'none'` and {@link scan} throws
 * `KitError('UNSUPPORTED')` — no heavy JS decoder fallback. Branch on {@link capability}.
 */
export class ScannerModule {
  constructor(private kit: NativeKit) {}

  /** 'native' on a shell · 'web' where BarcodeDetector exists · else 'none'. */
  get capability() {
    return this.kit.capability('scanner');
  }

  /** Open the scanner; resolve the first code, or `{ cancelled: true }` if dismissed. */
  scan(opts: ScanOptions = {}): Promise<ScanResult | ScanCancelled> {
    return this.kit.invoke('scanner.scan', opts);
  }

  /** Dismiss an in-progress {@link scan} (its promise then resolves `{ cancelled: true }`). */
  cancel(): Promise<void> {
    return this.kit.invoke('scanner.cancel');
  }
}
