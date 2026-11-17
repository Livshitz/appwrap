/** Why `headphoneMotion.start` must refuse, or null to proceed. Pure (no NativeScript globals) so it is unit-tested.
 * Missing usage key = iOS kills the process on start; denied/restricted = CoreMotion silently sends nothing, so the
 * page would wait forever — both must surface as a real error. */
export function headphoneStartBlocker(usageKeyPresent: boolean, authorization: string): { code: string; message: string } | null {
  if (!usageKeyPresent) {
    return { code: 'NOT_CONFIGURED', message: 'NSMotionUsageDescription missing — enable the `headphoneMotion` module in appwrap.config' };
  }
  if (authorization === 'denied' || authorization === 'restricted') {
    return { code: 'PERMISSION_DENIED', message: `Motion & Fitness access is ${authorization} — the user can allow it in Settings` };
  }
  return null;
}
