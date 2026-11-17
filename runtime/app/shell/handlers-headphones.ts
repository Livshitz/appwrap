import { WebView, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { pauseInBackground } from './background-pause';
import { SHELL_CONFIG } from './config';

/**
 * Headphone head-tracking (`headphoneMotion` module) — opt-in, strippable, iOS only.
 * CMHeadphoneMotionManager (iOS 14+) streams the attitude of supported headphones (AirPods Pro/Max/3rd gen,
 * Beats with head tracking). Android has no public equivalent → the handshake reports 'none' there.
 *
 * Bridge:
 *   headphoneMotion.isAvailable → { available, connected, authorization, configured }
 *   headphoneMotion.start {hz?} → streams `headphoneMotion.data` events (default 50 Hz, clamp 5–100)
 *   headphoneMotion.stop
 *   event headphoneMotion.connection { connected } — the delegate's didConnect / didDisconnect
 *
 * Sampling mirrors phone motion (handlers-parity): startDeviceMotionUpdates() + a main-thread read of
 * `deviceMotion` on a native timer, NOT CoreMotion's queue-handler block (the repeated JS↔ObjC block is
 * fragile under NativeScript). A sample is emitted only when its timestamp moved, so asking 50 Hz from
 * headphones that report slower never re-sends the same sample.
 *
 * Lifetime: stopped when the WebView that started it reloads or is replaced (the listener that wanted it
 * is gone), and paused while backgrounded UNLESS the app plays background audio
 * (`backgroundAudio: true`), where head-tracked panning must keep following the head.
 */

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Missing NSMotionUsageDescription = iOS kills the process on the first CMHeadphoneMotionManager start. */
function usageKeyPresent(): boolean {
  return !!NSBundle.mainBundle.objectForInfoDictionaryKey('NSMotionUsageDescription');
}

function authorizationName(): string {
  switch (CMHeadphoneMotionManager.authorizationStatus()) {
    case CMAuthorizationStatus.Authorized: return 'authorized';
    case CMAuthorizationStatus.Denied: return 'denied';
    case CMAuthorizationStatus.Restricted: return 'restricted';
    default: return 'notDetermined';
  }
}

// any: holder for the runtime-built ObjC delegate class (built lazily: NSObject is an iOS-only global).
let HeadphoneDelegate: any = null;
function ensureDelegateClass(): void {
  if (HeadphoneDelegate) return;
  @NativeClass()
  class HeadphoneDelegateImpl extends NSObject implements CMHeadphoneMotionManagerDelegate {
    static ObjCProtocols = [CMHeadphoneMotionManagerDelegate];
    onChange: ((connected: boolean) => void) | null = null;
    static new(): HeadphoneDelegateImpl {
      return <HeadphoneDelegateImpl>super.new();
    }
    headphoneMotionManagerDidConnect(_m: CMHeadphoneMotionManager): void { this.onChange?.(true); }
    headphoneMotionManagerDidDisconnect(_m: CMHeadphoneMotionManager): void { this.onChange?.(false); }
  }
  HeadphoneDelegate = HeadphoneDelegateImpl;
}

export function registerHeadphoneMotionHandlers(): void {
  if (!isIOS) return; // no handler → the kit sees UNSUPPORTED (and the handshake already says 'none')

  let manager: CMHeadphoneMotionManager | null = null;
  let delegate: any = null; // strong ref — CMHeadphoneMotionManager.delegate is weak
  let timer: ReturnType<typeof setInterval> | null = null;
  let hz = 0; // > 0 while the page holds the stream (survives a background pause)
  let connected: boolean | null = null; // null = unknown until the delegate reports
  let lastT = -1;
  const watchedViews = new WeakSet<object>();
  let startedFor: unknown = null; // the WebView whose page asked for the stream

  const setConnected = (c: boolean) => {
    if (connected === c) return;
    connected = c;
    bridge.emit('headphoneMotion.connection', { connected: c });
  };

  const start = () => {
    if (manager) return; // resumeEvent also fires on inactive→active with no prior suspend
    const mm = CMHeadphoneMotionManager.new();
    if (!mm.deviceMotionAvailable) throw err('UNSUPPORTED', 'Headphone motion is not available on this device');
    ensureDelegateClass();
    delegate = HeadphoneDelegate.new();
    delegate.onChange = setConnected;
    mm.delegate = delegate;
    manager = mm;
    lastT = -1;
    if (typeof mm.startConnectionStatusUpdates === 'function') mm.startConnectionStatusUpdates();
    mm.startDeviceMotionUpdates();
    timer = setInterval(() => {
      if (bridge.getWebView() !== startedFor) { stopAll(); return; } // page recreated / WebView gone
      const m = mm.deviceMotion;
      if (!m || m.timestamp === lastT) return; // no sample yet / headphones report slower than hz
      lastT = m.timestamp;
      const a = m.attitude;
      const q = a.quaternion;
      bridge.emit('headphoneMotion.data', {
        qx: q.x, qy: q.y, qz: q.z, qw: q.w,
        yaw: a.yaw, pitch: a.pitch, roll: a.roll, // radians
        rx: m.rotationRate.x, ry: m.rotationRate.y, rz: m.rotationRate.z, // rad/s
        t: m.timestamp, // seconds since device boot (CMLogItem.timestamp)
      });
    }, 1000 / hz);
  };

  const halt = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (manager) {
      manager.stopDeviceMotionUpdates();
      if (typeof manager.stopConnectionStatusUpdates === 'function') manager.stopConnectionStatusUpdates();
      manager.delegate = null;
    }
    manager = null;
    delegate = null;
  };

  const stopAll = () => {
    hz = 0;
    halt();
  };

  // With background audio the session keeps playing while locked: head-tracked panning must keep up.
  pauseInBackground(() => hz > 0 && !SHELL_CONFIG.backgroundAudio, halt, start, () => (hz = 0));

  bridge.register('headphoneMotion.isAvailable', () => {
    const configured = usageKeyPresent();
    const available = CMHeadphoneMotionManager.new().deviceMotionAvailable;
    return { available, connected, authorization: authorizationName(), configured };
  });

  bridge.register('headphoneMotion.start', (p: { hz?: number } = {}) => {
    if (!usageKeyPresent()) {
      throw err('NOT_CONFIGURED', 'NSMotionUsageDescription missing — enable the `headphoneMotion` module in appwrap.config');
    }
    const want = Math.max(5, Math.min(100, p.hz || 50));
    if (hz === want && manager) return;
    halt(); // a new rate restarts the timer
    hz = want;
    try {
      start();
    } catch (e) {
      hz = 0;
      throw e;
    }
    // The page that asked is the only consumer: a RELOAD drops its listener, so stop. Only navType
    // 'reload' — NativeScript's loadStarted also fires for iframe + same-document navigations, which must
    // not kill a mini-app's stream. (A swapped WebView is caught by the timer's identity check.)
    const wv = bridge.getWebView();
    startedFor = wv;
    if (wv && !watchedViews.has(wv)) {
      watchedViews.add(wv);
      // any: NS LoadEventData — navigationType is on the event, not in the base EventData type
      wv.on(WebView.loadStartedEvent, (e: any) => { if (hz && e?.navigationType === 'reload') stopAll(); });
    }
  });

  bridge.register('headphoneMotion.stop', () => stopAll());
}
