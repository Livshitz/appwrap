import { describe, expect, test } from 'bun:test';
import { isOffsite } from '../app/shell/offsite';

const u = (s: string) => { const x = new URL(s); return { scheme: x.protocol.slice(0, -1), host: x.hostname, port: x.port || undefined }; };

describe('isOffsite (a popup opens in the in-app browser, not over the app)', () => {
  test('another site', () => expect(isOffsite(u('https://developer.apple.com/x'), u('http://mac.local:7707/'))).toBe(true));
  test('the shell page origin', () => expect(isOffsite(u('http://mac.local:7707/m/mail'), u('http://mac.local:7707/'))).toBe(false));
  test('same host, other port', () => expect(isOffsite(u('http://mac.local:8080/'), u('http://mac.local:7707/'))).toBe(true));
  test('non-http schemes stay', () => { expect(isOffsite({ scheme: 'mailto' }, u('https://a.com/'))).toBe(false); expect(isOffsite({ scheme: 'app', host: 'localhost' }, u('https://a.com/'))).toBe(false); });
  test('no page URL', () => expect(isOffsite(u('https://a.com/'), null)).toBe(true));
});
