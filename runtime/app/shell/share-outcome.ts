/** How a share sheet ended — what `share.share` / `share.files` resolve with (native-kit `ShareResult`). */
export interface ShareOutcome {
  completed: boolean;
  activity?: string;
}

/**
 * Decide whether ONE `UIActivityViewController.completionWithItemsHandler` call ends the share.
 * iOS 13+ calls the handler with (activityType, completed=false) when a sub-activity (Mail, Messages)
 * is cancelled while the sheet STAYS open for another pick — resolving there would report "cancelled"
 * and lose the real outcome. So: a completed activity ends it; otherwise only a sheet that is no longer
 * presented does. `null` = not over yet, wait for the next call (or the dismissal re-check).
 */
export function settleShare(
  activityType: string | null | undefined,
  completed: boolean,
  sheetStillPresented: boolean
): ShareOutcome | null {
  if (completed) return activityType ? { completed: true, activity: String(activityType) } : { completed: true };
  return sheetStillPresented ? null : { completed: false };
}

/** What `share.saveToPhotos` resolves with (native-kit `SaveToPhotosResult`). `saved:false` is never a
 * throw: `reason` says why — 'denied' (the person refused, or Settings forbids it: only they can change
 * it), 'unsupported' (not an image/video, or no handler on this platform), 'failed' (the write itself). */
export interface SaveToPhotosOutcome {
  saved: boolean;
  reason?: 'denied' | 'unsupported' | 'failed';
  message?: string;
}

/** Which photo-library asset a file becomes — by mime type, then by extension. `null` = neither (a
 * library only holds photos and videos; a PDF must go through the share sheet instead). */
export function photoAssetKind(mimeType?: string, name?: string): 'image' | 'video' | null {
  const m = String(mimeType ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  const ext = String(name ?? '').toLowerCase().split('.').pop() ?? '';
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v'].includes(ext)) return 'video';
  return null;
}
