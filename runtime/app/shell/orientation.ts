/**
 * iOS supported-orientation mask, shared between the AppDelegate
 * (`application:supportedInterfaceOrientationsForWindow:`) and the
 * `screen.orientation.*` handlers. Raw UIInterfaceOrientationMask bit values
 * (1 << UIInterfaceOrientation) so no ambient UIKit types are needed.
 */
export const ORIENTATION_MASK = {
  portrait: 1 << 1, // 2
  portraitUpsideDown: 1 << 2, // 4
  landscapeLeft: 1 << 3, // 8
  landscapeRight: 1 << 4, // 16
  landscape: (1 << 3) | (1 << 4), // 24
  allButUpsideDown: (1 << 1) | (1 << 3) | (1 << 4), // 26 — default, free rotation sans upside-down
};

let iosMask = ORIENTATION_MASK.allButUpsideDown;

/** The mask the AppDelegate reports to UIKit. */
export function iosOrientationMask(): number {
  return iosMask;
}

/** Map a `kit.screen.orientation` lock value to an iOS mask. */
export function maskForLock(orientation: string): number {
  switch (orientation) {
    case 'portrait':
      return ORIENTATION_MASK.portrait;
    case 'portrait-upside-down':
      return ORIENTATION_MASK.portraitUpsideDown;
    case 'landscape':
      return ORIENTATION_MASK.landscape;
    case 'landscape-left':
      return ORIENTATION_MASK.landscapeLeft;
    case 'landscape-right':
      return ORIENTATION_MASK.landscapeRight;
    default:
      return ORIENTATION_MASK.allButUpsideDown; // 'any' / unlock
  }
}

export function setIosOrientationMask(mask: number): void {
  iosMask = mask;
}
