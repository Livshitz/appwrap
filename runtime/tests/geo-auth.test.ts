import { describe, expect, test } from 'bun:test';
import { CL_AUTH, geoAuthAction } from '../app/shell/geo-auth';

describe('geoAuthAction', () => {
  test('denied → rejects INSTANTLY with DENIED (never a timeout)', () => {
    expect(geoAuthAction(CL_AUTH.denied)).toEqual({
      kind: 'reject', code: 'DENIED', message: 'location permission denied',
    });
  });

  test('restricted → rejects with RESTRICTED, distinct from DENIED (was: burned 15s → TIMEOUT)', () => {
    const r = geoAuthAction(CL_AUTH.restricted);
    expect(r.kind).toBe('reject');
    expect((r as any).code).toBe('RESTRICTED');
  });

  test('a permission state NEVER maps to waiting/starting — the headline invariant', () => {
    for (const st of [CL_AUTH.denied, CL_AUTH.restricted]) {
      expect(geoAuthAction(st).kind).toBe('reject');
    }
  });

  test('authorized (whenInUse + always) → start locating', () => {
    expect(geoAuthAction(CL_AUTH.authorizedWhenInUse)).toEqual({ kind: 'start' });
    expect(geoAuthAction(CL_AUTH.authorizedAlways)).toEqual({ kind: 'start' });
  });

  test('notDetermined → request the prompt (and, per contract, arm no timer)', () => {
    expect(geoAuthAction(CL_AUTH.notDetermined)).toEqual({ kind: 'request' });
  });

  test('unknown/future status → request (safe + self-correcting), never a silent hang', () => {
    expect(geoAuthAction(99).kind).toBe('request');
  });
});
