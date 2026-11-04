import { test, expect, afterEach } from 'bun:test';
import { WebAdapter } from '../src/core/web-adapter';

/** 'current' pins what's on screen now — a tilt-controlled view must not rotate the app under the player. */

const g = globalThis as any;
const saved = Object.getOwnPropertyDescriptor(g, 'screen');
afterEach(() => { if (saved) Object.defineProperty(g, 'screen', saved); else delete g.screen; });

function stubScreen(type: string) {
    const locks: string[] = [];
    g.screen = { orientation: { type, lock: async (o: string) => { locks.push(o); }, unlock() {} } };
    return locks;
}

test("web lock('current') locks to the CURRENT screen type, not a literal 'current'", async () => {
    const locks = stubScreen('landscape-secondary');
    await new WebAdapter().invoke('screen.orientation.lock', { orientation: 'current' });
    await new WebAdapter().invoke('screen.orientation.lock', { orientation: 'landscape-right' });
    expect(locks).toEqual(['landscape-secondary', 'landscape-secondary']);
});

test('web lock rejection surfaces as KitError UNSUPPORTED (never an unhandled DOMException)', async () => {
    g.screen = { orientation: { type: 'portrait-primary', lock: () => Promise.reject(new Error('fullscreen required')) } };
    await expect(new WebAdapter().invoke('screen.orientation.lock', { orientation: 'current' }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED' });
});
