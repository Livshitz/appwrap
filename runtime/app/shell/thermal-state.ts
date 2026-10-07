/**
 * Pure device thermal-state mapping (no NativeScript/UIKit globals — unit-testable).
 * One 4-value contract on both platforms, emitted as `device.thermal.change` and returned by
 * `device.thermal`: 'nominal' | 'fair' | 'serious' | 'critical'.
 */
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

const IOS: ThermalState[] = ['nominal', 'fair', 'serious', 'critical'];

/** iOS `NSProcessInfoThermalState` raw value (0..3) → contract. Unknown → 'nominal'. */
export function iosThermalState(raw: number): ThermalState {
  return IOS[raw] ?? 'nominal';
}

/** Android `PowerManager.THERMAL_STATUS_*` (0 NONE … 6 SHUTDOWN) → contract. LIGHT/MODERATE
 * throttle without visible UX impact → 'fair'; SEVERE → 'serious'; CRITICAL and above → 'critical'. */
export function androidThermalState(status: number): ThermalState {
  if (status >= 4) return 'critical';
  if (status === 3) return 'serious';
  if (status >= 1) return 'fair';
  return 'nominal';
}
