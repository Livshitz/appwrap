import type { NativeKit } from '../core/NativeKit';

export interface CalendarEventOptions {
  title: string;
  /** ISO datetime; defaults to now + 1h. */
  start?: string;
  durationMin?: number;
  notes?: string;
}

/** Calendar write — native: EventKit (requires `calendar` permission in appwrap.json). Web: 'none'. */
export class CalendarModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('calendar');
  }

  /** Create an event in the default calendar; resolves its identifier. */
  createEvent(opts: CalendarEventOptions): Promise<{ id: string }> {
    return this.kit.invoke('calendar.createEvent', opts, { timeoutMs: 120_000 });
  }
}
