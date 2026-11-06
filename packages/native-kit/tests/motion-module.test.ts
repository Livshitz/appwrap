import { test, expect } from 'bun:test';
import { MotionModule } from '../src/modules/motion';

/** A fake kit that behaves like every adapter: ONE stream, a second motion.start is ignored. */
function fakeKit() {
  const calls: string[] = [];
  let hz = 0;
  const kit = {
    on: () => () => {},
    capability: () => 'native',
    invoke: async (m: string, p?: { hz?: number }) => {
      calls.push(p?.hz ? `${m}:${p.hz}` : m);
      if (m === 'motion.start' && !hz) hz = p?.hz || 10;
      if (m === 'motion.stop') hz = 0;
    },
  };
  return { kit: kit as any, calls, hz: () => hz };
}

test('a 60 Hz watcher opened after a 20 Hz one gets 60 Hz, and the stream drops back when it leaves', async () => {
  const f = fakeKit();
  const motion = new MotionModule(f.kit);
  const stopShake = await motion.watch(() => {}, { hz: 20 });
  expect(f.hz()).toBe(20);
  const stopGame = await motion.watch(() => {}, { hz: 60 });
  expect(f.hz()).toBe(60); // old code: still 20 — the adapter ignored the second start
  stopGame();
  await new Promise((r) => setTimeout(r, 0));
  expect(f.hz()).toBe(20); // shake keeps its stream (old code: stopped for everyone)
  stopShake();
  await new Promise((r) => setTimeout(r, 0));
  expect(f.hz()).toBe(0);
});

test('a slower watcher joining does not restart the stream', async () => {
  const f = fakeKit();
  const motion = new MotionModule(f.kit);
  await motion.watch(() => {}, { hz: 60 });
  await motion.watch(() => {}, { hz: 20 });
  expect(f.calls).toEqual(['motion.start:60']);
});
