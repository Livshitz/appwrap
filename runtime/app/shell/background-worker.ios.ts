// iOS stub. The WorkManager Worker is Android-only; handlers-background.ts STATICALLY imports
// `AppwrapBackgroundWorker`, so the name must resolve on iOS too — but it must carry NO `@JavaProxy` /
// `androidx` references (those are undefined on iOS and would crash ES-module instantiation at launch).
// registerAndroid() is the only consumer and never runs on iOS, so this value is never dereferenced.
export const AppwrapBackgroundWorker: any = undefined;
