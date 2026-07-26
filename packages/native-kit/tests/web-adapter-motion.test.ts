import { test, expect, afterEach } from 'bun:test';
import { WebAdapter } from '../src/core/web-adapter';
import type { MotionSample } from '../src/modules/motion';

/**
 * The WebAdapter must emit the SAME `motion.data` contract as the native handlers, because
 * kit.motion.watch() consumers can't tell which adapter served them. Both native paths
 * (handlers-parity.ts → CoreMotion, handlers-android.ts → TYPE_GYROSCOPE) report rotation rate in
 * RAD/s about x/y/z. The DOM reports deg/s keyed alpha/beta/gamma = the rates about Z/X/Y — two
 * independent mismatches (a 57.3× scale AND an axis permutation) that are invisible on web-only
 * testing and only show up as "tilt is wrong on web but fine on device".
 */

const g = globalThis as any;
const saved = new Map<string, PropertyDescriptor | undefined>();
function setGlobal(k: string, v: any) {
    if (!saved.has(k)) saved.set(k, Object.getOwnPropertyDescriptor(g, k));
    g[k] = v;
}
afterEach(() => {
    for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
    saved.clear();
});

/** Minimal DOM surface the adapter's motion path touches, with a hook to fire a devicemotion event. */
function stubDom() {
    let handler: ((e: any) => void) | null = null;
    setGlobal('DeviceMotionEvent', function () {}); // no requestPermission → non-iOS: no prompt path
    setGlobal('window', {
        addEventListener: (t: string, h: any) => { if (t === 'devicemotion') handler = h; },
        removeEventListener: () => { handler = null; },
    });
    // Deterministic clock: the adapter throttles emits with performance.now() against a `last` that
    // starts at 0, so with the real clock the first sample is dropped or kept depending on how many
    // ms into the process we are — a flaky rig. Advance well past any emit interval per fire.
    let t = 1e6;
    setGlobal('performance', { now: () => (t += 1000) });
    return { fire: (e: any) => handler?.(e) };
}

test('web motion.data honors the kit contract: rotation in rad/s about x/y/z (not raw DOM deg/s alpha/beta/gamma)', async () => {
    const dom = stubDom();
    const adapter = new WebAdapter();
    const samples: MotionSample[] = [];
    (adapter as any).on("motion.data", (s: MotionSample) => samples.push(s));
    await (adapter as any).invoke('motion.start', { hz: 60 });

    dom.fire({
        accelerationIncludingGravity: { x: 0.5, y: -1.5, z: -9.81 },
        // DOM deg/s: alpha = rate about Z, beta = about X, gamma = about Y
        rotationRate: { alpha: 180, beta: 90, gamma: 45 },
    });

    expect(samples.length).toBe(1);
    const s = samples[0];
    expect(s.ax).toBeCloseTo(0.5, 6);
    expect(s.ay).toBeCloseTo(-1.5, 6);
    expect(s.az).toBeCloseTo(-9.81, 6);
    // deg → rad AND re-keyed onto the correct axes
    expect(s.rx!).toBeCloseTo(Math.PI / 2, 6);  // from beta (about X), 90 deg/s
    expect(s.ry!).toBeCloseTo(Math.PI / 4, 6);  // from gamma (about Y), 45 deg/s
    expect(s.rz!).toBeCloseTo(Math.PI, 6);      // from alpha (about Z), 180 deg/s
    // the exact bug this guards: raw passthrough would put alpha(180) straight onto rx
    expect(s.rx).not.toBeCloseTo(180, 3);
});

test('web motion.data leaves rotation undefined when the device has no gyro (never fabricates 0)', async () => {
    const dom = stubDom();
    const adapter = new WebAdapter();
    const samples: MotionSample[] = [];
    (adapter as any).on("motion.data", (s: MotionSample) => samples.push(s));
    await (adapter as any).invoke('motion.start', { hz: 60 });

    dom.fire({ accelerationIncludingGravity: { x: 1, y: 2, z: 3 }, rotationRate: null });

    expect(samples.length).toBe(1);
    expect(samples[0].rx).toBeUndefined();
    expect(samples[0].ry).toBeUndefined();
    expect(samples[0].rz).toBeUndefined();
});
