import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createKeyboardShowCycle, resolveKeyboardHeight } from '../app/shell/keyboard-frame';

/**
 * iOS keyboard avoidance must never leave the webview shrunk once the keyboard is gone.
 * Field bug pinned: Blank's "Fan Reach" call dialog (input in a showModal <dialog> in a sandboxed
 * iframe, then TTS + STT) left a half-screen empty band that persisted onto the home grid.
 */
const H = 844; // iPhone 13 Pro window height (pt)
const KB = { y: H - 336 }; // on-screen keyboard end frame

describe('resolveKeyboardHeight', () => {
  test('cold show applies the on-screen overlap', () => {
    expect(resolveKeyboardHeight({ tag: 'willShow', inShowCycle: true, end: KB, containerHeight: H })).toEqual({ height: 336 });
  });

  test('warm re-focus (didShow-only) still applies', () => {
    expect(resolveKeyboardHeight({ tag: 'didShow', inShowCycle: true, end: KB, containerHeight: H }).height).toBe(336);
    expect(resolveKeyboardHeight({ tag: 'didShow', inShowCycle: true, end: KB, containerHeight: H }).skip).toBeUndefined();
  });

  test('willChangeFrame inside a show cycle (keyboard resize) applies', () => {
    const end = { y: H - 380 };
    expect(resolveKeyboardHeight({ tag: 'willChangeFrame', inShowCycle: true, end, containerHeight: H })).toEqual({ height: 380 });
  });

  test('willChangeFrame AFTER didHide with an on-screen frame does not re-shrink', () => {
    expect(resolveKeyboardHeight({ tag: 'willChangeFrame', inShowCycle: false, end: KB, containerHeight: H })).toEqual({ height: 0, skip: 'out-of-cycle' });
  });

  test('keyboard-sized off-screen dismissal frame is zero overlap', () => {
    expect(resolveKeyboardHeight({ tag: 'willChangeFrame', inShowCycle: true, end: { y: H }, containerHeight: H }).skip).toBe('off-screen');
  });

  test('no container height never falls back to the raw frame height', () => {
    expect(resolveKeyboardHeight({ tag: 'didShow', inShowCycle: true, end: { y: H }, containerHeight: 0 })).toEqual({ height: 0, skip: 'no-frame' });
  });

  test('bogus full-screen frame is skipped', () => {
    expect(resolveKeyboardHeight({ tag: 'willShow', inShowCycle: true, end: { y: 0 }, containerHeight: H }).skip).toBe('bogus');
  });
});

describe('createKeyboardShowCycle', () => {
  const frame = (tag: 'willShow' | 'didShow' | 'willChangeFrame') => ({ tag, end: KB, containerHeight: H });

  test('a fresh cycle ignores a stray willChangeFrame', () => {
    expect(createKeyboardShowCycle().resolve(frame('willChangeFrame')).skip).toBe('out-of-cycle');
  });

  test('willShow opens the cycle so a following willChangeFrame resize applies', () => {
    const cycle = createKeyboardShowCycle();
    expect(cycle.resolve(frame('willShow'))).toEqual({ height: 336 });
    expect(cycle.resolve(frame('willChangeFrame'))).toEqual({ height: 336 });
  });

  test('a skipped (off-screen / no-frame) didShow does not open the cycle for a stray willChangeFrame', () => {
    const cycle = createKeyboardShowCycle();
    expect(cycle.resolve({ tag: 'didShow', end: { y: H }, containerHeight: H }).skip).toBe('off-screen');
    expect(cycle.resolve(frame('willChangeFrame')).skip).toBe('out-of-cycle');
    expect(cycle.resolve({ tag: 'didShow', containerHeight: H }).skip).toBe('no-frame');
    expect(cycle.resolve(frame('willChangeFrame')).skip).toBe('out-of-cycle');
  });

  test('a bogus (autofill full-screen) willShow still opens the cycle so the real frame lands', () => {
    const cycle = createKeyboardShowCycle();
    expect(cycle.resolve({ tag: 'willShow', end: { y: 0 }, containerHeight: H }).skip).toBe('bogus');
    expect(cycle.resolve(frame('willChangeFrame'))).toEqual({ height: 336 });
  });

  test('warm re-focus (didShow-only) re-opens the cycle after a hide', () => {
    const cycle = createKeyboardShowCycle();
    cycle.resolve(frame('willShow'));
    cycle.close();
    expect(cycle.resolve(frame('willChangeFrame')).skip).toBe('out-of-cycle');
    expect(cycle.resolve(frame('didShow'))).toEqual({ height: 336 });
    expect(cycle.resolve(frame('willChangeFrame'))).toEqual({ height: 336 });
  });
});

// Source-level wiring (keyboard.ts imports NativeScript and can't load under bun).
const src = readFileSync(join(import.meta.dir, '..', 'app', 'shell', 'keyboard.ts'), 'utf8');
describe('keyboard.ts wiring', () => {
  test('onShow routes through the show-cycle gate', () => {
    expect(src).toMatch(/showCycle\.resolve\(\{/);
    expect(src).not.toMatch(/resolveKeyboardHeight\(/);
  });
  test('both hide notifications close the show cycle', () => {
    const hides = src.split('UIKeyboardWillHideNotification, null, null')[1] ?? '';
    expect((hides.match(/showCycle\.close\(\)/g) ?? []).length).toBe(2);
  });
  test('restore to full height does not wait for the webview to be in a window', () => {
    expect(src).toMatch(/if \(!wv \|\| !wk \|\| \(paddingBottom > 0 && !win\)\)/);
  });
});
