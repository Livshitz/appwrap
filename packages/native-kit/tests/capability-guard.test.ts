/**
 * Unit test for the runtime's TCC capability guard (web-quirks `capabilityGuardJs` + its parts).
 * The guards are pure JS strings injected at document-start in the native shell / mini-app webviews;
 * we evaluate them against a mock `navigator`/`MediaDevices` and assert: undeclared camera/mic reject
 * getUserMedia (crash-proofing), declared capabilities pass through, undeclared geolocation fast-denies
 * with PERMISSION_DENIED, declared geolocation is untouched, and capabilityGuardJs composes both.
 */
import { describe, expect, test } from 'bun:test';
import { capabilityGuardJs, geolocationGuardJs, mediaCaptureGuardJs } from '../../../runtime/app/shell/web-quirks';

/** Run a guard snippet against a fresh mock env; the snippet references bare `navigator`/`window`. */
function run(src: string) {
  let realGumCalled = 0;
  const proto = { getUserMedia() { realGumCalled++; return Promise.resolve('real-stream'); } };
  const realGet = () => { throw new Error('real getCurrentPosition ran'); };
  const geolocation: any = { getCurrentPosition: realGet, watchPosition: realGet, clearWatch() {} };
  const navigator: any = { mediaDevices: { getUserMedia: proto.getUserMedia }, geolocation };
  const window: any = { MediaDevices: { prototype: proto }, navigator };
  // navigator.mediaDevices.getUserMedia delegates to the patched prototype in a real browser; mirror that.
  navigator.mediaDevices.getUserMedia = (c: any) => proto.getUserMedia.call(proto, c);
  // eslint-disable-next-line no-new-func
  new Function('navigator', 'window', 'Promise', 'DOMException', 'setTimeout', src)(
    navigator, window, Promise, DOMException, (fn: () => void) => fn()
  );
  return { navigator, window, proto, realGet, realGumCalled: () => realGumCalled };
}

describe('mediaCaptureGuardJs (crash-proofing undeclared capture)', () => {
  test('undeclared camera → getUserMedia({video}) rejects, real path never entered', async () => {
    const { proto, realGumCalled } = run(mediaCaptureGuardJs(false, false));
    await expect(proto.getUserMedia({ video: true })).rejects.toThrow(/camera/);
    expect(realGumCalled()).toBe(0);
  });

  test('declared camera+mic → passes straight through to the native path', async () => {
    const { proto, realGumCalled } = run(mediaCaptureGuardJs(true, true));
    await expect(proto.getUserMedia({ video: true, audio: true })).resolves.toBe('real-stream');
    expect(realGumCalled()).toBe(1);
  });
});

describe('geolocationGuardJs (graceful degrade when undeclared)', () => {
  test('undeclared → getCurrentPosition fast-denies with PERMISSION_DENIED, real path never runs', () => {
    const { navigator, realGet } = run(geolocationGuardJs(false));
    expect(navigator.geolocation.getCurrentPosition).not.toBe(realGet);
    let err: any = null;
    navigator.geolocation.getCurrentPosition(() => { throw new Error('success cb ran'); }, (e: any) => { err = e; });
    expect(err).not.toBeNull();
    expect(err.code).toBe(1); // PERMISSION_DENIED
  });

  test('undeclared → watchPosition also denies and returns a watch id', () => {
    const { navigator } = run(geolocationGuardJs(false));
    let err: any = null;
    const id = navigator.geolocation.watchPosition(() => {}, (e: any) => { err = e; });
    expect(typeof id).toBe('number');
    expect(err?.code).toBe(1);
  });

  test('declared → geolocation is left untouched (WebKit/CoreLocation own the prompt)', () => {
    const { navigator, realGet } = run(geolocationGuardJs(true));
    expect(navigator.geolocation.getCurrentPosition).toBe(realGet);
  });
});

describe('capabilityGuardJs (composed guard)', () => {
  test('composes media + geolocation: both guards active when nothing declared', () => {
    const { navigator, proto, realGet, realGumCalled } = run(
      capabilityGuardJs({ camera: false, microphone: false, geolocation: false })
    );
    // geolocation guarded
    expect(navigator.geolocation.getCurrentPosition).not.toBe(realGet);
    // media guarded
    void proto.getUserMedia({ video: true }).catch(() => {});
    expect(realGumCalled()).toBe(0);
  });

  test('all declared → media passes through, geolocation untouched', async () => {
    const { navigator, proto, realGet, realGumCalled } = run(
      capabilityGuardJs({ camera: true, microphone: true, geolocation: true })
    );
    expect(navigator.geolocation.getCurrentPosition).toBe(realGet); // geo guard is a no-op
    await expect(proto.getUserMedia({ video: true, audio: true })).resolves.toBe('real-stream');
    expect(realGumCalled()).toBe(1);
  });
});
