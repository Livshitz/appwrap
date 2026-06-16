import type { NativeKit } from '../core/NativeKit';

/** Store review prompt — iOS SKStoreReviewController. The OS rate-limits display. */
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
