import { Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { androidThermalState, iosThermalState, type ThermalState } from './thermal-state';

declare const NSNotificationCenter: any;
declare const NSProcessInfo: any;
declare const NSProcessInfoThermalStateDidChangeNotification: any;
declare const NSOperationQueue: any;

/** Current device thermal state. Android < API 29 has no thermal API → 'nominal'. */
export function thermalState(): ThermalState {
  if (isIOS) return iosThermalState(Number(NSProcessInfo.processInfo.thermalState));
  if (isAndroid && android.os.Build.VERSION.SDK_INT >= 29) {
    const pm = Utils.android.getApplicationContext().getSystemService(android.content.Context.POWER_SERVICE);
    return androidThermalState(Number(pm.getCurrentThermalStatus()));
  }
  return 'nominal';
}

/** Forward OS thermal changes to the PWA as `device.thermal.change` (deduped to real transitions).
 * The PWA reads the current value via `device.thermal` on subscribe. */
export function startThermalForwarding(): void {
  let last = thermalState();
  const emit = (s: ThermalState) => {
    if (s === last) return;
    last = s;
    bridge.emit('device.thermal.change', { state: s });
  };
  try {
    if (isIOS) {
      NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
        // Posted on an arbitrary thread — hop to main: the emit drives WKWebView evaluateJavaScript.
        NSProcessInfoThermalStateDidChangeNotification, null, NSOperationQueue.mainQueue, () => emit(thermalState())
      );
    } else if (isAndroid && android.os.Build.VERSION.SDK_INT >= 29) {
      const pm = Utils.android.getApplicationContext().getSystemService(android.content.Context.POWER_SERVICE);
      // any: PowerManager.OnThermalStatusChangedListener is API 29 — absent from older typings.
      const Listener = (android.os as any).PowerManager.OnThermalStatusChangedListener;
      pm.addThermalStatusListener(new Listener({ onThermalStatusChanged: (st: number) => emit(androidThermalState(st)) }));
    }
  } catch (e) {
    console.warn('AppWrap: thermal forwarding unavailable', e);
  }
}
