/**
 * Ambient augmentations for the non-standard / experimental Web APIs the WebAdapter
 * feature-detects. These are NOT in the current TS DOM lib, so without these decls
 * each touch would need an `as any` cast. Shapes are intentionally MINIMAL — only the
 * members web-adapter.ts actually reads — but REAL (no `any`), so call sites stay typed.
 *
 * Anything the DOM lib already types (setAppBadge/clearAppBadge, speechSynthesis,
 * SpeechSynthesisUtterance, visualViewport, mediaDevices, wakeLock, ScreenOrientation
 * core, storage.getDirectory, HTMLVideoElement.playsInline/srcObject) is deliberately
 * absent here and used straight off the lib types.
 */

export {};

/** A picked contact from the Contact Picker API (navigator.contacts.select). */
interface WebContact {
  name?: string[];
  tel?: string[];
  email?: string[];
}

/** A detected code from the Barcode Detection API. */
interface DetectedBarcode {
  rawValue: string;
  format: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

/** Minimal BarcodeDetector surface (Chrome/Android). */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

/** Minimal Web Speech `SpeechRecognition` surface (Chrome/webkit). */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
}

declare global {
  interface Navigator {
    /** Battery Status API — resolves a snapshot the adapter reads `level`/`charging` off. */
    getBattery?(): Promise<{ level: number; charging: boolean }>;
    /** Contact Picker API. */
    contacts?: {
      select(properties: string[], options?: { multiple?: boolean }): Promise<WebContact[]>;
    };
    /** Network Information API (non-standard `connection`). */
    connection?: { type?: string };
  }

  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }

  /** Screen Orientation lock/unlock — newer than the lib's ScreenOrientation interface. */
  interface ScreenOrientation {
    lock?(orientation: string): Promise<void>;
    unlock?(): void;
  }

  /** OPFS directory async iterator — newer than the lib's FileSystemDirectoryHandle interface. */
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }

  /** iOS Safari gates DeviceMotion behind an explicit permission prompt (static method) — the lib
   * already declares `DeviceMotionEvent` as a `var`, so this can't merge onto it; web-adapter casts
   * the constructor to this shape at the single call site instead. */
  interface DeviceMotionEventWithPermission {
    requestPermission?(): Promise<'granted' | 'denied' | 'prompt'>;
  }
}
