import type { NativeKit } from '../core/NativeKit';

/** In-app store review prompt — iOS SKStoreReviewController / Android Play In-App Review (opt-in
 *  `reviews` module). The OS rate-limits display; on Android it only surfaces for a Play-Store-track
 *  install (a sideload/emulator no-ops without showing UI). Fire-and-forget either way. */
export class ReviewsModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('reviews');
  }

  /** Ask the OS to show the in-app review prompt. Fire-and-forget; the OS decides. */
  requestReview(): Promise<void> {
    return this.kit.invoke('reviews.requestReview');
  }
}
