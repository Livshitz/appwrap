// Base / iOS module for `./background-worker`. The WorkManager Worker is Android-only; the real
// `@JavaProxy` class lives in `background-worker.android.ts` (NS resolves the `.android.ts` override on
// Android). This base resolves for plain `tsc` (which doesn't know NS platform suffixes) AND serves as
// the iOS runtime impl — it must carry NO `@JavaProxy` / `androidx` references (undefined on iOS, they'd
// crash ES-module instantiation at launch). registerAndroid() — the only consumer — never runs on iOS,
// so this value is never dereferenced there.
export const AppwrapBackgroundWorker: any = undefined;
