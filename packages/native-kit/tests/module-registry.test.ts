import { describe, expect, jest, test } from 'bun:test';
import { ModuleRegistry } from '../src/core/module-registry';
import { NativeKit } from '../src/core/NativeKit';

describe('ModuleRegistry', () => {
  test('register + get round-trip returns the SAME instance', () => {
    const reg = new ModuleRegistry();
    const inst = { id: 'billing' };
    reg.registerModule('billing', inst);
    expect(reg.getModule('billing')).toBe(inst);
    expect(reg.hasModule('billing')).toBe(true);
  });

  test('getModule on an unknown name throws, listing mounted names + the modulePacks hint', () => {
    const reg = new ModuleRegistry();
    reg.registerModule('billing', {});
    reg.registerModule('haptics', {});
    let err: Error | null = null;
    try {
      reg.getModule('nope');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("module 'nope' is not registered");
    // lists currently-mounted names
    expect(err!.message).toContain('billing');
    expect(err!.message).toContain('haptics');
    // the required hint
    expect(err!.message).toContain('Did you list its pack in modulePacks?');
  });

  test('factory is memoized — called once, same instance thereafter', () => {
    const reg = new ModuleRegistry();
    const inst = { lazy: true };
    const factory = jest.fn(() => inst);
    reg.registerModule('lazy', factory);
    expect(factory).not.toHaveBeenCalled(); // not built until first get
    const a = reg.getModule('lazy');
    const b = reg.getModule('lazy');
    expect(a).toBe(inst);
    expect(b).toBe(inst);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('NativeKit registry wiring (behaviour-identical)', () => {
  test('getModule returns the SAME instance as the eager field', () => {
    const kit = new NativeKit();
    expect(kit.getModule('app')).toBe(kit.app);
    expect(kit.modules.getModule('haptics')).toBe(kit.haptics);
    expect(kit.getModule('oauth')).toBe(kit.oauth);
  });

  test('all eager fields are mounted in the registry', () => {
    const kit = new NativeKit();
    const names = kit.modules.moduleNames();
    for (const n of ['app', 'oauth', 'media', 'haptics', 'appleSignIn', 'backgroundTask', 'shareTarget']) {
      expect(names).toContain(n);
    }
  });

  test('unknown module throws at the call site (does not hang or return undefined)', () => {
    const kit = new NativeKit();
    expect(() => kit.getModule('billin' as any)).toThrow(/Did you list its pack in modulePacks\?/);
  });
});
