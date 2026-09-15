/**
 * iOS share sheet outcome — `share.share` / `share.files` resolve when the sheet ENDS with
 * `{ completed, activity? }`. Contract: a completed activity ends it (with its type), a dismissed sheet
 * ends it as not completed, and a cancelled sub-activity while the sheet stays open does NOT end it.
 */
import { describe, expect, test } from 'bun:test';
import { settleShare } from '../app/shell/share-outcome';

describe('settleShare', () => {
  test('"Save Video" completes with its activity type', () => {
    expect(settleShare('com.apple.UIKit.activity.SaveToCameraRoll', true, false))
      .toEqual({ completed: true, activity: 'com.apple.UIKit.activity.SaveToCameraRoll' });
  });
  test('completed while the sheet is still animating out still completes', () => {
    expect(settleShare('com.apple.UIKit.activity.CopyToPasteboard', true, true))
      .toEqual({ completed: true, activity: 'com.apple.UIKit.activity.CopyToPasteboard' });
  });
  test('completed with no activity type carries no activity key', () => {
    expect(settleShare(null, true, false)).toEqual({ completed: true });
  });
  test('sheet dismissed without a pick → not completed', () => {
    expect(settleShare(null, false, false)).toEqual({ completed: false });
  });
  test('sub-activity cancelled while the sheet stays open → not over yet', () => {
    expect(settleShare('com.apple.UIKit.activity.Mail', false, true)).toBeNull();
  });
});

import { photoAssetKind } from '../app/shell/share-outcome';

describe('photoAssetKind', () => {
  test('mime type decides first', () => {
    expect(photoAssetKind('video/mp4', 'x.png')).toBe('video');
    expect(photoAssetKind('image/png')).toBe('image');
  });
  test('falls back to the extension when the mime type is generic', () => {
    expect(photoAssetKind('application/octet-stream', 'clip.MOV')).toBe('video');
    expect(photoAssetKind('', 'shot.jpeg')).toBe('image');
  });
  test('anything else is not a photo-library asset', () => {
    expect(photoAssetKind('application/pdf', 'a.pdf')).toBeNull();
    expect(photoAssetKind(undefined, undefined)).toBeNull();
  });
});
