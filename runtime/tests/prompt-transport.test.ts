import { describe, test, expect } from 'bun:test';
import { TRANSPORT_SHIM, PROMPT_PREFIX, CHUNK_PREFIX, takeChunk } from '../app/shell/prompt-transport';

/** Run the shim against a fake window; returns what native's onJsPrompt would see. */
const send = (json: string) => {
  const prompts: string[] = [];
  const window: any = { prompt: (m: string) => { prompts.push(m); } };
  new Function('window', TRANSPORT_SHIM)(window);
  window.appwrapNative.postMessage(json);
  return prompts;
};
const deliver = (prompts: string[], url = 'https://appwrap.local/') => {
  const out: string[] = [];
  for (const m of prompts) {
    if (m.startsWith(PROMPT_PREFIX)) out.push(m.slice(PROMPT_PREFIX.length));
    else { const j = takeChunk(m.slice(CHUNK_PREFIX.length), url); if (j !== null) out.push(j); }
  }
  return out;
};

describe('prompt transport', () => {
  test('a small envelope is one prompt', () => {
    const p = send('{"a":1}');
    expect(p).toEqual([PROMPT_PREFIX + '{"a":1}']);
  });
  test('a large envelope is chunked under the ~10K prompt cap and reassembled exactly (surrogates intact)', () => {
    const json = JSON.stringify({ js: 'x'.repeat(7999) + '😀'.repeat(5000) + 'tail' });
    const p = send(json);
    expect(p.length).toBeGreaterThan(1);
    for (const m of p) expect(m.length).toBeLessThan(10000);
    for (const m of p) expect(/[\uD800-\uDBFF]$/.test(m)).toBe(false);
    expect(deliver(p)).toEqual([json]);
  });
  test('parts from a different page url are dropped', () => {
    const p = send('y'.repeat(20000));
    const out: (string | null)[] = p.map((m, i) => takeChunk(m.slice(CHUNK_PREFIX.length), i ? 'https://evil.example/' : 'https://appwrap.local/'));
    expect(out.every((x) => x === null)).toBe(true);
  });
});
