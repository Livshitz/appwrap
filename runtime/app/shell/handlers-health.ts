import { Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { requestPermissions, startActivityForResult } from './android-helpers';

declare const cc: any; // no NS types: generated Kotlin HealthConnectBridge (HealthConnectBridge.kt shim, overrides/)

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Step counting from the platform health store — today's total, global, survives an app kill.
 * iOS: HealthKit. Android: Health Connect (via the HealthConnectBridge.kt shim) with a
 * SensorManager TYPE_STEP_COUNTER fallback when Health Connect isn't available. */
export function registerHealthHandlers(): void {
  if (isIOS) registerIos();
  else if (isAndroid) registerAndroid();
}

/** NSNumber/JS-number tolerant read. */
function num(v: any): number {
  if (typeof v === 'number') return v;
  if (v && typeof v.doubleValue === 'number') return v.doubleValue; // NSNumber
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function registerIos(): void {
  // HealthKit reads the Health app's AGGREGATED step total (iPhone + Apple Watch + other sources) —
  // recorded by the OS regardless of the app, so it's global and survives kill. Count = today's sum.
  const store = HKHealthStore.new();
  const stepType = HKObjectType.quantityTypeForIdentifier('HKQuantityTypeIdentifierStepCount');
  const startOfToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0); // local midnight
    return NSDate.dateWithTimeIntervalSince1970(d.getTime() / 1000);
  };

  bridge.register('health.requestAccess', () =>
    new Promise((resolve) => {
      if (!HKHealthStore.isHealthDataAvailable()) { resolve(false); return; }
      const readSet = NSSet.setWithObject(stepType);
      // null typesToShare (read-only request) — SDK types the param as a non-nullable NSSet.
      store.requestAuthorizationToShareTypesReadTypesCompletion(null as any, readSet, (ok: boolean, e: NSError) => {
        Utils.dispatchToMainThread(() => resolve(!!ok && !e));
      });
    })
  );

  bridge.register('health.start', () => {
    if (!HKHealthStore.isHealthDataAvailable()) throw err('UNSUPPORTED', 'HealthKit unavailable on this device');
  });
  bridge.register('health.stop', () => {});

  // HKStatisticsQuery completion fires off-main — settle the bridge promise on the main thread so the
  // WKWebView response delivery (evaluateJavaScript) is main-thread.
  bridge.register('health.count', () =>
    new Promise((resolve, reject) => {
      // NS marshals NSDate→the SDK's `Date` param type; options 0 = HKQueryOptions.None.
      const predicate = HKQuery.predicateForSamplesWithStartDateEndDateOptions(
        startOfToday() as unknown as Date, NSDate.date() as unknown as Date, HKQueryOptions.None
      );
      const q = HKStatisticsQuery.alloc().initWithQuantityTypeQuantitySamplePredicateOptionsCompletionHandler(
        stepType, predicate, HKStatisticsOptions.CumulativeSum, (_q: HKStatisticsQuery, stats: HKStatistics, e: NSError) => {
          Utils.dispatchToMainThread(() => {
            if (e) { reject(err('NATIVE_ERROR', e.localizedDescription ?? 'health query failed')); return; }
            const sum = stats && stats.sumQuantity ? stats.sumQuantity() : null;
            resolve({ steps: sum ? Math.round(sum.doubleValueForUnit(HKUnit.countUnit())) : 0 });
          });
        }
      );
      store.executeQuery(q);
    })
  );

  // ── Live steps (CMPedometer) — low-latency "as you walk" count, distinct from the laggy HealthKit
  // aggregate. Caller uses HealthKit as the periodic source-of-truth and these live deltas in between.
  // Emits `health.liveStep` { steps } (today's pedometer total since local midnight). iPhone-only
  // (no Watch), which is fine: it's the live driver; HealthKit re-anchors the authoritative total.
  let pedometer: CMPedometer | null = null;
  let anchorDay = -1; // local day-of-month the current stream is anchored to (for midnight re-anchor)
  const localDay = () => new Date().getDate();
  const startStream = () => {
    if (!pedometer) return;
    anchorDay = localDay();
    // startOfToday() returns an NSDate; the SDK types `start` as JS Date but NativeScript marshals it.
    pedometer.startPedometerUpdatesFromDateWithHandler(startOfToday() as unknown as Date, (data: CMPedometerData, e: NSError) => {
      if (e || !data) return;
      // Midnight self-heal: CMPedometer counts since the FIXED anchor date, so after local midnight
      // numberOfSteps still includes yesterday. When the day rolls over, restart from the new
      // midnight (re-anchors to 0) so the live count stays "today only".
      if (localDay() !== anchorDay) { Utils.dispatchToMainThread(() => { pedometer?.stopPedometerUpdates(); startStream(); bridge.emit('health.liveStep', { steps: 0 }); }); return; }
      const steps = Math.round(num(data.numberOfSteps));
      Utils.dispatchToMainThread(() => bridge.emit('health.liveStep', { steps }));
    });
  };
  bridge.register('health.liveSteps.start', () => {
    if (typeof CMPedometer === 'undefined' || !CMPedometer.isStepCountingAvailable())
      throw err('UNSUPPORTED', 'Pedometer (live step counting) unavailable on this device');
    // Motion & Fitness denied/restricted → surface it so the caller can fall back to HealthKit instead
    // of silently receiving no events.
    const auth = typeof CMPedometer.authorizationStatus === 'function'
      ? CMPedometer.authorizationStatus()
      : CMAuthorizationStatus.NotDetermined;
    if (auth === CMAuthorizationStatus.Denied || auth === CMAuthorizationStatus.Restricted)
      throw err('DENIED', 'Motion & Fitness access is off for live step counting');
    if (pedometer) return; // already streaming
    pedometer = CMPedometer.new();
    startStream();
  });
  bridge.register('health.liveSteps.stop', () => {
    pedometer?.stopPedometerUpdates();
    pedometer = null;
  });
}

function registerAndroid(): void {
  const ctx = () => Utils.android.getApplicationContext();
  const HCB = () => cc.livx.appwrap.HealthConnectBridge;
  // Primary path = Health Connect (system store, Wear-inclusive, survives kill). Cached once.
  let hc: boolean | null = null;
  const hcAvailable = () => {
    if (hc == null) {
      try { hc = !!HCB().isAvailable(ctx()); } catch (e) { hc = false; }
    }
    return hc;
  };

  // ── sensor fallback (TYPE_STEP_COUNTER) — when Health Connect isn't available ──
  let sensorManager: android.hardware.SensorManager | null = null;
  let listener: android.hardware.SensorEventListener | null = null;
  let baseline: number | null = null;
  let latest: number | null = null;
  let registered = false;
  const ensureSensor = () => {
    // getSystemService is typed `any` by the SDK; narrow to the concrete manager.
    if (!sensorManager) sensorManager = ctx().getSystemService(android.content.Context.SENSOR_SERVICE) as android.hardware.SensorManager;
  };
  const stopSensor = () => {
    if (registered && sensorManager && listener) { sensorManager.unregisterListener(listener); registered = false; }
  };
  const startSensor = () => {
    ensureSensor();
    const sensor = sensorManager!.getDefaultSensor(android.hardware.Sensor.TYPE_STEP_COUNTER);
    if (!sensor) throw err('UNSUPPORTED', 'No step-counter sensor on this device');
    stopSensor();
    baseline = null;
    latest = null;
    listener = new android.hardware.SensorEventListener({
      onSensorChanged: (ev: android.hardware.SensorEvent) => { const v = num(ev.values[0]); latest = v; if (baseline == null) baseline = v; },
      onAccuracyChanged: () => {},
    });
    sensorManager!.registerListener(listener, sensor, android.hardware.SensorManager.SENSOR_DELAY_NORMAL);
    registered = true;
  };
  const sensorCount = () => ({ steps: baseline != null && latest != null ? Math.max(0, Math.round(latest - baseline)) : 0 });

  bridge.register('health.requestAccess', async () => {
    if (hcAvailable()) {
      // Launch the Health Connect permission UI, then re-check what was granted.
      await startActivityForResult(HCB().permissionIntent(ctx())).catch((e) => console.warn('[health] HC permission intent failed', e));
      return new Promise((resolve) =>
        HCB().hasPermission(ctx(), new (HCB().BoolCallback)({ onResult: (g: boolean) => resolve(!!g) }))
      );
    }
    return requestPermissions(['android.permission.ACTIVITY_RECOGNITION']);
  });

  bridge.register('health.start', () => { if (!hcAvailable()) startSensor(); });
  bridge.register('health.stop', () => { if (!hcAvailable()) stopSensor(); });

  bridge.register('health.count', () => {
    if (hcAvailable()) {
      // Health Connect: today's aggregated total (dedupes across sources incl. Wear).
      return new Promise((resolve) =>
        HCB().readTodaySteps(ctx(), new (HCB().LongCallback)({ onResult: (v: any) => { const n = Number(v); resolve({ steps: n > 0 ? n : 0 }); } }))
      );
    }
    return sensorCount();
  });
}
