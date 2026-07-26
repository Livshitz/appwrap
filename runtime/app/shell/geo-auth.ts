/**
 * PURE CoreLocation authorization-status → action mapping (no NativeScript imports; bun-tested).
 * Mirrors notif-identity.ts: the decision lives here so the permission semantics are verifiable
 * off-device, and handlers-extended.ts only does the CoreLocation plumbing.
 *
 * WHY this exists: a permission state must NEVER surface to the user as a timeout. `denied` and
 * `restricted` are TERMINAL answers we already know — they must reject INSTANTLY with a distinct
 * code, not sit until some watchdog gives up and reports a hang.
 */

/** CLAuthorizationStatus raw values (stable ObjC enum; hardcoded so this module stays iOS-global-free). */
export const CL_AUTH = {
  notDetermined: 0,
  restricted: 1,
  denied: 2,
  authorizedAlways: 3,
  authorizedWhenInUse: 4,
} as const;

export type GeoAuthAction =
  /** Terminal: reject now with this KitError code — no surface, no waiting. */
  | { kind: 'reject'; code: 'DENIED' | 'RESTRICTED'; message: string }
  /** Authorized: start locating. The caller arms its location timer HERE (not before). */
  | { kind: 'start' }
  /** Not yet asked: present the system prompt and WAIT for the decision. The caller must NOT arm a
   * timer — the prompt is dismiss-bound (the user may take as long as they like) and, worse, iOS
   * THROTTLES the WebContent renderer while it is up, so a timer that fires now produces a response
   * that cannot be delivered. See Bridge.respond. */
  | { kind: 'request' };

/** Map a CLAuthorizationStatus to what geo.current should do. Unknown/future values → request
 * (asking is safe and self-correcting: the delegate re-enters here with the real status). */
export function geoAuthAction(status: number): GeoAuthAction {
  switch (status) {
    case CL_AUTH.denied:
      return { kind: 'reject', code: 'DENIED', message: 'location permission denied' };
    case CL_AUTH.restricted:
      // Parental controls / MDM / Screen Time. The user CANNOT grant it — asking is pointless and
      // waiting is a lie. Distinct from DENIED: "denied" is fixable in Settings, "restricted" is not.
      return { kind: 'reject', code: 'RESTRICTED', message: 'location access is restricted on this device' };
    case CL_AUTH.authorizedAlways:
    case CL_AUTH.authorizedWhenInUse:
      return { kind: 'start' };
    case CL_AUTH.notDetermined:
    default:
      return { kind: 'request' };
  }
}
