import { describe, expect, test } from 'bun:test';
// The appleSignIn handler hashes the raw nonce with this pure-JS SHA-256 before sending it to Apple.
// It lives in the NativeScript shell (no NS imports), so it's directly unit-testable here.
import { sha256Hex } from '../../../runtime/app/shell/sha256';

describe('sha256Hex (appleSignIn nonce hashing)', () => {
  // NIST / RFC test vectors.
  test('empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  test('"abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('56-char message (crosses a block boundary)', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    );
  });
  test('long input', () => {
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });
  test('unicode (UTF-8 encoded)', () => {
    // SHA-256 of the UTF-8 bytes of "é" (0xC3 0xA9).
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
  });
  test('deterministic', () => {
    expect(sha256Hex('raw-nonce-xyz')).toBe(sha256Hex('raw-nonce-xyz'));
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});
