import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { runHandlers } from '../src/handlers';

/** Drive runHandlers with in-memory streams; collect emitted NDJSON objects, feed request lines. */
function harness(map: Parameters<typeof runHandlers>[0]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  let buf = '';
  output.on('data', (c) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (l.trim()) lines.push(JSON.parse(l));
    }
  });
  runHandlers(map, input, output);
  const send = (obj: unknown) => input.write(JSON.stringify(obj) + '\n');
  const raw = (line: string) => input.write(line + '\n');
  // let async handlers + stream flush settle
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { lines, send, raw, settle };
}

describe('runHandlers — sidecar protocol v1 envelopes', () => {
  test('emits a ready line with the method keys on start', () => {
    const { lines } = harness({ 'a.foo': () => 1, 'a.bar': () => 2 });
    expect(lines[0]).toEqual({ kind: 'ready', methods: ['a.foo', 'a.bar'] });
  });

  test('resolves a request → ok:true with returned data', async () => {
    const { lines, send, settle } = harness({ 'a.echo': (p) => ({ got: p }) });
    send({ kind: 'request', id: 'r1', method: 'a.echo', params: { x: 5 } });
    await settle();
    expect(lines.find((l) => l.id === 'r1')).toEqual({
      kind: 'response', id: 'r1', ok: true, data: { got: { x: 5 } },
    });
  });

  test('awaits async handlers', async () => {
    const { lines, send, settle } = harness({
      'a.async': async (p) => { await new Promise((r) => setTimeout(r, 5)); return p.n * 2; },
    });
    send({ kind: 'request', id: 'r2', method: 'a.async', params: { n: 21 } });
    await settle();
    expect(lines.find((l) => l.id === 'r2')).toEqual({ kind: 'response', id: 'r2', ok: true, data: 42 });
  });

  test('undefined/void return → data:null', async () => {
    const { lines, send, settle } = harness({ 'a.void': () => {} });
    send({ kind: 'request', id: 'r3', method: 'a.void', params: null });
    await settle();
    expect(lines.find((l) => l.id === 'r3')).toEqual({ kind: 'response', id: 'r3', ok: true, data: null });
  });

  test('a throwing handler → ok:false NATIVE_ERROR, does not crash the loop', async () => {
    const { lines, send, settle } = harness({
      'a.boom': () => { throw new Error('kaboom'); },
      'a.ok': () => 'fine',
    });
    send({ kind: 'request', id: 'e1', method: 'a.boom', params: {} });
    send({ kind: 'request', id: 'e2', method: 'a.ok', params: {} });
    await settle();
    expect(lines.find((l) => l.id === 'e1')).toEqual({
      kind: 'response', id: 'e1', ok: false, error: { code: 'NATIVE_ERROR', message: 'kaboom' },
    });
    // loop survived — the next request still resolves
    expect(lines.find((l) => l.id === 'e2')).toEqual({ kind: 'response', id: 'e2', ok: true, data: 'fine' });
  });

  test('unknown method → ok:false UNSUPPORTED (defensive; shell only forwards claimed methods)', async () => {
    const { lines, send, settle } = harness({ 'a.foo': () => 1 });
    send({ kind: 'request', id: 'u1', method: 'a.nope', params: {} });
    await settle();
    expect(lines.find((l) => l.id === 'u1')).toEqual({
      kind: 'response', id: 'u1', ok: false, error: { code: 'UNSUPPORTED', message: 'a.nope not implemented' },
    });
  });

  test('malformed and non-request lines are ignored (no response, no crash)', async () => {
    const { lines, send, raw, settle } = harness({ 'a.foo': () => 1 });
    raw('this is not json {{{');
    send({ kind: 'event', id: 'x' }); // not a request
    send({ kind: 'request', id: 'g1', method: 'a.foo', params: {} });
    await settle();
    // only the ready line + the g1 response — the two junk lines produced nothing
    expect(lines.filter((l) => l.kind === 'response')).toHaveLength(1);
    expect(lines.find((l) => l.id === 'g1')).toEqual({ kind: 'response', id: 'g1', ok: true, data: 1 });
  });
});
