import { describe, expect, test } from 'bun:test';
import { AudioSessionPolicy } from '../app/shell/audio-session-policy';

const PLAYBACK = { mode: 'playback' as const, mixWithOthers: false };

function bootedWithBackgroundAudio() {
  const p = new AudioSessionPolicy();
  p.setBootDefault(PLAYBACK);
  return p;
}

describe('interruption end', () => {
  test('no claim + boot default → nothing re-applied (the session stays WebKit\'s; a mic page keeps recording)', () => {
    expect(bootedWithBackgroundAudio().onInterruptionEnded(true, true)).toEqual({ apply: null, activate: false });
  });

  test('explicit playback claim, category unchanged, shouldResume → re-apply + activate', () => {
    const p = bootedWithBackgroundAudio();
    p.setClaim(PLAYBACK);
    expect(p.onInterruptionEnded(true, true)).toEqual({ apply: PLAYBACK, activate: true });
  });

  test('claim but WebKit moved the category (playAndRecord for getUserMedia) → leave it alone', () => {
    const p = bootedWithBackgroundAudio();
    p.setClaim(PLAYBACK);
    expect(p.onInterruptionEnded(true, false)).toEqual({ apply: null, activate: false });
  });

  test('claim but the system says do not resume → nothing', () => {
    const p = bootedWithBackgroundAudio();
    p.setClaim(PLAYBACK);
    expect(p.onInterruptionEnded(false, true)).toEqual({ apply: null, activate: false });
  });

  test('claim cleared on a new top-level document → no re-activation for the new page', () => {
    const p = bootedWithBackgroundAudio();
    p.setClaim(PLAYBACK);
    p.clearClaim();
    expect(p.onInterruptionEnded(true, true)).toEqual({ apply: null, activate: false });
  });
});

describe('releaseAudio', () => {
  test('with a claim → claim dropped, boot default restored, deactivate', () => {
    const p = bootedWithBackgroundAudio();
    p.setClaim({ mode: 'voiceChat', mixWithOthers: false });
    expect(p.onRelease()).toEqual({ noop: false, apply: PLAYBACK, deactivate: true });
    expect(p.claim).toBeNull();
  });

  test('without backgroundAudio → apply null (system default category)', () => {
    const p = new AudioSessionPolicy();
    p.setClaim(PLAYBACK);
    expect(p.onRelease()).toEqual({ noop: false, apply: null, deactivate: true });
  });

  test('without a claim → no-op', () => {
    expect(bootedWithBackgroundAudio().onRelease()).toEqual({ noop: true, apply: null, deactivate: false });
  });

  test('release then interruption end → nothing re-applied', () => {
    const p = bootedWithBackgroundAudio();
    p.setClaim(PLAYBACK);
    p.onRelease();
    expect(p.onInterruptionEnded(true, true)).toEqual({ apply: null, activate: false });
  });

  test('release then media-services reset → boot default category, NOT activated', () => {
    const p = bootedWithBackgroundAudio();
    p.setClaim(PLAYBACK);
    p.onRelease();
    expect(p.onMediaServicesReset()).toEqual({ apply: PLAYBACK, activate: false });
  });
});

describe('media-services reset', () => {
  test('no claim → restore the boot CATEGORY only, never activate (the user\'s music keeps playing)', () => {
    expect(bootedWithBackgroundAudio().onMediaServicesReset()).toEqual({ apply: PLAYBACK, activate: false });
  });

  test('live claim → restore it and activate', () => {
    const p = bootedWithBackgroundAudio();
    const claim = { mode: 'voiceChat' as const, mixWithOthers: false };
    p.setClaim(claim);
    expect(p.onMediaServicesReset()).toEqual({ apply: claim, activate: true });
  });

  test('no boot default and no claim → nothing', () => {
    expect(new AudioSessionPolicy().onMediaServicesReset()).toEqual({ apply: null, activate: false });
  });
});
