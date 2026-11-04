import { test, expect } from 'bun:test';
import { maskForInterfaceOrientation, maskForLock, ORIENTATION_MASK } from '../app/shell/orientation';

test("iOS 'current' pins exactly the live interface orientation", () => {
    expect(maskForInterfaceOrientation(1)).toBe(ORIENTATION_MASK.portrait);
    expect(maskForInterfaceOrientation(3)).toBe(ORIENTATION_MASK.landscapeLeft);
    expect(maskForInterfaceOrientation(4)).toBe(ORIENTATION_MASK.landscapeRight);
    expect(maskForInterfaceOrientation(0)).toBe(ORIENTATION_MASK.portrait); // unknown → safe default
    expect(maskForLock('any')).toBe(ORIENTATION_MASK.allButUpsideDown);
});
