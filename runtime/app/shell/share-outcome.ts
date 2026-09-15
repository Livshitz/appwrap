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
