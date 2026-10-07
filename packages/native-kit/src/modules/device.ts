import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

export interface DeviceInfo {
  model: string;
  os: string;
  osVersion: string;
  language: string;
  region?: string;
  manufacturer?: string;
  battery?: { level: number; charging: boolean };
}

/** OS thermal pressure. Lower work (frame rate, haptics, effects) at 'serious'/'critical'. */
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export class DeviceModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('device');
  }

  info(): Promise<DeviceInfo> {
    return this.kit.invoke('device.info');
  }

  /** Current thermal state. Web (no API) → 'nominal'. */
  thermalState(): Promise<ThermalState> {
    return this.kit.invoke('device.thermal');
  }

  /** Delivers the current state once on subscribe, then every transition. */
  onThermalChange(cb: (state: ThermalState) => void): Unsubscribe {
    let live = true;
    let changed = false; // a real transition beats the (possibly slower) initial read
    const off = this.kit.on('device.thermal.change', (p) => {
      changed = true;
      cb((p as { state: ThermalState }).state);
    });
    this.thermalState().then(
      (s) => { if (live && !changed) cb(s); },
      () => {} // older shell without the handler: no initial value, transitions still arrive
    );
    return () => { live = false; off(); };
  }
}
