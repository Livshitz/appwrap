/**
 * Unit test for the runtime's service-worker-neutralization snippet (web-quirks `serviceWorkerGuardJs`).
 * The snippet is a pure JS string injected at document-start in the native shell; we evaluate it
 * against a mock `navigator`/`window` and assert the chosen semantics: register neutralized (pending
 * promise), feature-detection still truthful, Worker/SharedWorker untouched, idempotent, opt-out no-op,
 * and pre-existing registrations torn down.
 */
import { describe, expect, test } from 'bun:test';
// Pure exported string-builder from the runtime shell (no NativeScript imports on this path).
import { serviceWorkerGuardJs } from '../../../runtime/app/shell/web-quirks';

/** Build a fresh mock global env, run the snippet against it, return the env for assertions. */
function evalGuard(enabled: boolean, opts?: { withExisting?: boolean }) {
  const origRegister = function register() {
    return Promise.resolve({ tag: 'real-registration' });
  };
  let unregistered = 0;
  const registrations = opts?.withExisting
    ? [{ unregister: () => { unregistered++; return Promise.resolve(true); } }]
    : [];

  const navigator: any = {
    serviceWorker: {
      register: origRegister,
      getRegistrations: () => Promise.resolve(registrations),
      // `.ready` left as a never-settling promise (as a real browser would until a SW is ready).
      ready: new Promise(() => {}),
    },
  };
  // Worker / SharedWorker MUST be left intact — sentinels to prove the snippet never touches them.
  const WorkerSentinel = function Worker() {};
  const SharedWorkerSentinel = function SharedWorker() {};
  const window: any = { navigator, Worker: WorkerSentinel, SharedWorker: SharedWorkerSentinel };

  const src = serviceWorkerGuardJs(enabled);
  // The snippet references bare `navigator`/`window`/`Promise`; eval in a function scope with those bound.
  // eslint-disable-next-line no-new-func
  new Function('navigator', 'window', 'Promise', src)(navigator, window, Promise);

  return { navigator, window, origRegister, WorkerSentinel, SharedWorkerSentinel, unregistered: () => unregistered };
}

/** True if a promise has not settled within a microtask flush. */
async function isPending(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([p.then(() => 'resolved').catch(() => 'rejected'), Promise.resolve(marker)]);
  return winner === marker;
}

describe('serviceWorkerGuardJs (native shell SW neutralization)', () => {
  test('register is neutralized: returns a promise that never settles (no then/catch)', async () => {
    const { navigator, origRegister } = evalGuard(true);
    expect(navigator.serviceWorker.register).not.toBe(origRegister);
    const p = navigator.serviceWorker.register('/sw.js');
    expect(p).toBeInstanceOf(Promise);
    expect(await isPending(p)).toBe(true); // .then never runs, .catch never fires
  });

  test('feature-detection stays truthful: serviceWorker still present', () => {
    const { navigator } = evalGuard(true);
    expect('serviceWorker' in navigator).toBe(true);
    expect(typeof navigator.serviceWorker.register).toBe('function');
  });

  test('Worker and SharedWorker are left fully intact', () => {
    const { window, WorkerSentinel, SharedWorkerSentinel } = evalGuard(true);
    expect(window.Worker).toBe(WorkerSentinel);
    expect(window.SharedWorker).toBe(SharedWorkerSentinel);
  });

  test('tears down a pre-existing registration from a prior web session', async () => {
    const env = evalGuard(true, { withExisting: true });
    await Promise.resolve(); // let getRegistrations().then(...) flush
    await Promise.resolve();
    expect(env.unregistered()).toBe(1);
  });

  test('idempotent: a second injection is a no-op (guard prevents re-patching)', () => {
    const { navigator, window } = evalGuard(true);
    const patched = navigator.serviceWorker.register;
    expect(window.__appwrapSwGuard).toBe(true);
    // Re-run the snippet against the same env — must not re-wrap.
    new Function('navigator', 'window', 'Promise', serviceWorkerGuardJs(true))(navigator, window, Promise);
    expect(navigator.serviceWorker.register).toBe(patched);
  });

  test('opt-out (enabled=false): emits no code, leaves register original', () => {
    expect(serviceWorkerGuardJs(false)).toBe('');
    const { navigator, origRegister } = evalGuard(false);
    expect(navigator.serviceWorker.register).toBe(origRegister);
    expect(navigator.serviceWorker.register('/sw.js')).resolves.toEqual({ tag: 'real-registration' });
  });
});
