import { Application, Utils } from '@nativescript/core';
import { bridge } from './bridge';
import { requestPermissions, startActivityForResult, uriToDataUrl, bitmapToDataUrl } from './android-helpers';
import { notifIdentity } from './notif-identity';

// no NS types: android-32 typings omit ContactsContract/MediaStore column + ACTION_PICK_IMAGES constants this file reads
declare const android: any, androidx: any;

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

const CHANNEL_ID = 'appwrap';

/**
 * Android implementations for the iOS-first domains. Registered AFTER the other
 * handler sets (bridge.register overwrites), so each method here replaces its
 * `throw iosOnly()` placeholder on Android only. Call only when isAndroid.
 */
export function registerAndroidHandlers(): void {
  const context = () => Utils.android.getApplicationContext();
  const activity = () => Application.android.foregroundActivity ?? Application.android.startActivity;

  // ── notifications (NotificationManager + channel) ──────────────────
  const notificationManager = () =>
    context().getSystemService(android.content.Context.NOTIFICATION_SERVICE);
  const pendingTimers = new Map<number, any>();

  const ensureChannel = (channelId: string = CHANNEL_ID, name: string = 'Notifications') => {
    if (android.os.Build.VERSION.SDK_INT < 26) return;
    const channel = new android.app.NotificationChannel(
      channelId, name, android.app.NotificationManager.IMPORTANCE_DEFAULT
    );
    notificationManager().createNotificationChannel(channel); // idempotent; updates name in place
  };

  // Per-sender channel id — a stable, sanitized key so each mini-app gets its own row
  // in Android's notification settings (real per-"app" mute/importance).
  const senderChannelId = (sender: string) => 'sender-' + sender.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64);

  /** Decode an icon (http(s) URL or data-URI) to a Bitmap for setLargeIcon; null on failure.
   * Called on a background thread (URL fetch would throw NetworkOnMainThread otherwise). */
  const loadBitmap = (icon: string): android.graphics.Bitmap | null => {
    try {
      if (icon.startsWith('data:')) {
        const comma = icon.indexOf(',');
        const b64 = comma >= 0 ? icon.slice(comma + 1) : '';
        if (!b64) return null;
        const bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
        return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
      }
      const conn = new java.net.URL(icon).openConnection();
      conn.setConnectTimeout(5000);
      conn.setReadTimeout(5000);
      const stream = conn.getInputStream();
      const bmp = android.graphics.BitmapFactory.decodeStream(stream);
      stream.close();
      return bmp;
    } catch (e) {
      console.warn('AppWrap: notification largeIcon load failed', e);
      return null;
    }
  };

  bridge.register('notifications.requestPermission', async () => {
    if (android.os.Build.VERSION.SDK_INT < 33) return 'granted';
    const ok = await requestPermissions(['android.permission.POST_NOTIFICATIONS']);
    return ok ? 'granted' : 'denied';
  });

  bridge.register('notifications.schedule', ({ id, title, body, delaySec, deepLink, sender, icon, silent }: any) => {
    const ident = notifIdentity({ title, body, sender, icon });
    // Per-sender channel gives the mini-app its own identity + settings row; else the shared one.
    const channelId = ident.useIdentity && ident.senderName ? senderChannelId(ident.senderName) : CHANNEL_ID;
    ensureChannel(channelId, ident.useIdentity && ident.senderName ? ident.senderName : 'Notifications');
    const nid = id ?? Math.floor(Math.random() * 100000);
    const timer = setTimeout(() => {
      pendingTimers.delete(nid);
      const ctx = context();
      const builder = android.os.Build.VERSION.SDK_INT >= 26
        ? new android.app.Notification.Builder(ctx, channelId)
        : new android.app.Notification.Builder(ctx);
      builder
        .setSmallIcon(ctx.getApplicationInfo().icon)
        .setContentTitle(ident.title)
        .setAutoCancel(true);
      // The channel already carries the alert sound (IMPORTANCE_DEFAULT); `silent: true` is the
      // per-notification opt-out that matches iOS's nil-sound path. API 29+ only — below that the
      // channel's sound wins and there is nothing to suppress.
      if (silent && android.os.Build.VERSION.SDK_INT >= 29) builder.setSilent(true);
      if (ident.subtitle) builder.setSubText(ident.subtitle);
      if (ident.body) builder.setContentText(ident.body);
      // Tap → re-open the (singleTask) activity with a VIEW intent; onNewIntent
      // routes it through the same deep-link path as an external open.
      if (deepLink) {
        const viewIntent = new android.content.Intent(
          android.content.Intent.ACTION_VIEW, android.net.Uri.parse(String(deepLink))
        );
        viewIntent.setPackage(ctx.getPackageName());
        viewIntent.addFlags(
          android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP | android.content.Intent.FLAG_ACTIVITY_NEW_TASK
        );
        const piFlags = android.os.Build.VERSION.SDK_INT >= 23
          ? android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT
          : android.app.PendingIntent.FLAG_UPDATE_CURRENT;
        builder.setContentIntent(android.app.PendingIntent.getActivity(ctx, nid, viewIntent, piFlags));
      }
      // With an icon: fetch the bitmap off the main thread (URL fetch would crash on it),
      // set it as the large icon, then post. Without: post inline.
      if (ident.iconUrl) {
        new java.lang.Thread(new java.lang.Runnable({
          run: () => {
            const bmp = loadBitmap(ident.iconUrl);
            if (bmp) builder.setLargeIcon(bmp);
            notificationManager().notify(nid, builder.build());
          },
        })).start();
      } else {
        notificationManager().notify(nid, builder.build());
      }
    }, Math.max(1, delaySec ?? 1) * 1000);
    pendingTimers.set(nid, timer);
    return { id: nid };
  });

  bridge.register('notifications.pending', () => pendingTimers.size);

  bridge.register('notifications.setBadge', () => {
    // No portable badge API on Android — launchers own badges. Honest no-op.
  });

  bridge.register('notifications.clear', () => {
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
    notificationManager().cancelAll();
  });

  // ── biometrics (androidx.biometric BiometricPrompt) ────────────────
  bridge.register('biometrics.available', () => {
    try {
      const manager = androidx.biometric.BiometricManager.from(context());
      const ok = manager.canAuthenticate(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK)
        === androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS;
      return { available: ok, type: ok ? 'touch' : 'none' };
    } catch (e) {
      console.warn('AppWrap: biometrics.available failed', e);
      return { available: false, type: 'none' };
    }
  });

  // NS caches the Java proxy class synthesized by .extend({...}) by the methods-object SHAPE, so
  // re-extending per call would permanently bake in the FIRST call's resolve/reject closure — every
  // later authenticate would settle the first (already-settled) promise and hang its own. Extend once
  // and route through a mutable slot (only one biometric prompt can be active at a time).
  let biometricCallbackClass: any;
  let biometricPending: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;
  const getBiometricCallbackClass = () => {
    if (biometricCallbackClass) return biometricCallbackClass;
    biometricCallbackClass = (androidx.biometric.BiometricPrompt.AuthenticationCallback as any).extend({
      onAuthenticationSucceeded(_result: any) {
        biometricPending?.resolve({ success: true });
        biometricPending = null;
      },
      onAuthenticationError(_code: number, message: any) {
        biometricPending?.reject(err('DENIED', String(message ?? 'authentication error')));
        biometricPending = null;
      },
    });
    return biometricCallbackClass;
  };

  bridge.register('biometrics.authenticate', ({ reason }: { reason?: string }) => {
    return new Promise((resolve, reject) => {
      Utils.dispatchToMainThread(() => {
        try {
          const act = activity(); // NativeScriptActivity extends AppCompatActivity → FragmentActivity
          const executor = androidx.core.content.ContextCompat.getMainExecutor(act);
          biometricPending?.reject(err('DENIED', 'superseded by a new biometric prompt'));
          biometricPending = { resolve, reject };
          const Callback = getBiometricCallbackClass();
          const prompt = new androidx.biometric.BiometricPrompt(act, executor, new Callback());
          const info = new androidx.biometric.BiometricPrompt.PromptInfo.Builder()
            .setTitle(String(reason ?? 'Authenticate'))
            .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK)
            .setNegativeButtonText('Cancel')
            .build();
          prompt.authenticate(info);
        } catch (e: any) {
          if (biometricPending?.reject === reject) biometricPending = null;
          reject(err('UNSUPPORTED', e?.message ?? String(e)));
        }
      });
    });
  });

  // ── geolocation (LocationManager) ──────────────────────────────────
  const GEO_PERMS = ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'];
  const locationManager = () => context().getSystemService(android.content.Context.LOCATION_SERVICE);
  const toPosition = (loc: android.location.Location) => ({
    lat: loc.getLatitude(), lng: loc.getLongitude(), accuracy: loc.getAccuracy(),
  });
  const makeListener = (onLocation: (loc: android.location.Location) => void) =>
    new android.location.LocationListener({
      // Both overloads dispatch here — newer Android may deliver a List<Location>.
      onLocationChanged(arg: android.location.Location | java.util.List<android.location.Location>) {
        // interop: runtime duck-typing across the two Java overloads; TS can't narrow Java types here
        let loc: any = arg;
        if (loc && typeof loc.getLatitude !== 'function' && typeof loc.size === 'function') {
          loc = loc.size() > 0 ? loc.get(loc.size() - 1) : null;
        }
        if (loc) onLocation(loc);
      },
      onFlushComplete() {},
      onStatusChanged() {}, onProviderEnabled() {}, onProviderDisabled() {},
    });

  bridge.register('geo.current', async () => {
    if (!(await requestPermissions(GEO_PERMS))) throw err('DENIED', 'location permission denied');
    const lm = locationManager();
    return new Promise((resolve, reject) => {
      const last = lm.getLastKnownLocation(android.location.LocationManager.GPS_PROVIDER)
        ?? lm.getLastKnownLocation(android.location.LocationManager.NETWORK_PROVIDER);
      if (last) return resolve(toPosition(last));

      let listener: android.location.LocationListener | null = null;
      const timer = setTimeout(() => {
        if (listener) lm.removeUpdates(listener);
        reject(err('TIMEOUT', 'location timeout'));
      }, 15000);
      listener = makeListener((loc) => {
        clearTimeout(timer);
        lm.removeUpdates(listener);
        resolve(toPosition(loc));
      });
      Utils.dispatchToMainThread(() => {
        lm.requestLocationUpdates(android.location.LocationManager.GPS_PROVIDER, 0, 0, listener,
          android.os.Looper.getMainLooper());
      });
    });
  });

  let geoWatchListener: android.location.LocationListener | null = null;
  bridge.register('geo.watch.start', async () => {
    if (geoWatchListener) return; // already streaming
    if (!(await requestPermissions(GEO_PERMS))) throw err('DENIED', 'location permission denied');
    geoWatchListener = makeListener((loc) => bridge.emit('geo.position', toPosition(loc)));
    Utils.dispatchToMainThread(() => {
      locationManager().requestLocationUpdates(android.location.LocationManager.GPS_PROVIDER, 1000, 0,
        geoWatchListener, android.os.Looper.getMainLooper());
    });
  });

  bridge.register('geo.watch.stop', () => {
    if (geoWatchListener) locationManager().removeUpdates(geoWatchListener);
    geoWatchListener = null;
  });

  // ── photos (system photo picker / ACTION_GET_CONTENT) ──────────────
  bridge.register('photos.pick', async ({ dataUrl, maxSize }: any = {}) => {
    const intent = android.os.Build.VERSION.SDK_INT >= 33
      ? new android.content.Intent(android.provider.MediaStore.ACTION_PICK_IMAGES)
      : new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT).setType('image/*');
    const { resultCode, intent: result } = await startActivityForResult(intent);
    if (resultCode !== android.app.Activity.RESULT_OK || !result?.getData()) return { picked: false };

    const uri = result.getData();
    try {
      const opts = new android.graphics.BitmapFactory.Options();
      opts.inJustDecodeBounds = true;
      const stream = context().getContentResolver().openInputStream(uri);
      android.graphics.BitmapFactory.decodeStream(stream, null, opts);
      stream.close();
      const out: any = { picked: true, width: opts.outWidth, height: opts.outHeight };
      if (dataUrl) out.dataUrl = uriToDataUrl(uri, maxSize ?? 1024);
      return out;
    } catch (e) {
      console.warn('AppWrap: photos.pick size probe failed', e);
      return { picked: true };
    }
  });

  // ── screen (insets, brightness, keep-awake) ────────────────────────
  bridge.register('ui.safeArea', () => {
    const insets = { top: 0, bottom: 0, left: 0, right: 0 };
    try {
      const cutout = activity()?.getWindow()?.getDecorView()?.getRootWindowInsets()?.getDisplayCutout();
      if (cutout) {
        const dip = (px: number) => Utils.layout.toDeviceIndependentPixels(px);
        insets.top = dip(cutout.getSafeInsetTop());
        insets.bottom = dip(cutout.getSafeInsetBottom());
        insets.left = dip(cutout.getSafeInsetLeft());
        insets.right = dip(cutout.getSafeInsetRight());
      }
    } catch (e) {
      console.warn('AppWrap: ui.safeArea failed', e);
    }
    return insets;
  });

  bridge.register('ui.brightness.get', () => {
    const level = activity()?.getWindow()?.getAttributes()?.screenBrightness ?? -1;
    return level < 0 ? 0.5 : level; // -1 = follow system
  });

  bridge.register('ui.brightness.set', ({ level }: { level: number }) => {
    Utils.dispatchToMainThread(() => {
      const window = activity()?.getWindow();
      if (!window) return;
      const attrs = window.getAttributes();
      attrs.screenBrightness = Math.max(0, Math.min(1, level));
      window.setAttributes(attrs);
    });
  });

  bridge.register('ui.keepAwake', ({ on }: { on: boolean }) => {
    Utils.dispatchToMainThread(() => {
      const window = activity()?.getWindow();
      if (!window) return;
      const flag = android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
      on ? window.addFlags(flag) : window.clearFlags(flag);
    });
  });

  // ── motion (SensorManager: accelerometer + gyroscope) ──────────────
  const sensorManager = () => context().getSystemService(android.content.Context.SENSOR_SERVICE);
  let motionListener: android.hardware.SensorEventListener | null = null;
  const lastMotion = { ax: 0, ay: 0, az: 0, rx: 0, ry: 0, rz: 0 };

  bridge.register('motion.start', (p: { hz?: number } = {}) => {
    if (motionListener) return; // already streaming
    // Emit rate configurable (default 10 Hz; up to 60 for crisp tilt). SENSOR_DELAY_GAME feeds ~50 Hz;
    // we throttle the EMIT to the requested rate. Higher Hz = more bridge traffic/battery.
    const hz = Math.max(5, Math.min(60, p.hz || 10));
    const minMs = 1000 / hz;
    const sm = sensorManager();
    const accel = sm.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER);
    if (!accel) throw err('UNSUPPORTED', 'No accelerometer on this device');
    const gyro = sm.getDefaultSensor(android.hardware.Sensor.TYPE_GYROSCOPE);
    let last = 0;
    motionListener = new android.hardware.SensorEventListener({
      onAccuracyChanged() {},
      onSensorChanged(event: android.hardware.SensorEvent) {
        const v = event.values;
        if (event.sensor.getType() === android.hardware.Sensor.TYPE_ACCELEROMETER) {
          // NEGATE to match the kit/iOS convention: iOS CoreMotion delivers the gravity-DIRECTION
          // vector (rest az ≈ -9.81), whereas Android's accelerometer reports the REACTION force
          // (rest az ≈ +9.81) — the exact negation. Without this, gravity-vector tilt is inverted
          // on every axis vs iOS (confirmed on-device: steering reversed). m/s² units already match.
          lastMotion.ax = -v[0]; lastMotion.ay = -v[1]; lastMotion.az = -v[2];
        } else {
          lastMotion.rx = v[0]; lastMotion.ry = v[1]; lastMotion.rz = v[2];
        }
        const now = java.lang.System.currentTimeMillis();
        if (now - last < minMs) return; // throttle emit to the requested Hz
        last = now;
        bridge.emit('motion.data', { ...lastMotion });
      },
    });
    // Register at the REQUESTED rate as an explicit sampling period (µs), NOT SENSOR_DELAY_FASTEST:
    // on Android 12+ (API 31) any rate faster than 200 Hz — including FASTEST (0 µs) — throws
    // SecurityException unless the app declares HIGH_SAMPLING_RATE_SENSORS. Our hz is capped at 60
    // (≈16.7 ms), comfortably under 200 Hz, so a plain period needs no extra permission. Floor at
    // 5 ms (200 Hz) to stay below that threshold even if the cap ever rises.
    const periodUs = Math.max(5000, Math.round(1_000_000 / hz));
    sm.registerListener(motionListener, accel, periodUs);
    if (gyro) sm.registerListener(motionListener, gyro, periodUs);
  });

  bridge.register('motion.stop', () => {
    if (motionListener) sensorManager().unregisterListener(motionListener);
    motionListener = null;
  });

  // ── heading (SensorManager: rotation vector → compass azimuth) ─────
  // TYPE_ROTATION_VECTOR fuses accelerometer+magnetometer(+gyro) into an orientation; getOrientation
  // gives azimuth (rad, counter-clockwise from north), which we convert to a 0–360 compass heading.
  // UNVERIFIED-ON-DEVICE.
  let headingListener: android.hardware.SensorEventListener | null = null;

  bridge.register('heading.start', (p: { hz?: number } = {}) => {
    if (headingListener) return; // already streaming
    const hz = Math.max(1, Math.min(60, p.hz || 10));
    const minMs = 1000 / hz;
    const sm = sensorManager();
    const rot = sm.getDefaultSensor(android.hardware.Sensor.TYPE_ROTATION_VECTOR);
    if (!rot) throw err('UNSUPPORTED', 'No rotation-vector sensor (compass) on this device');
    const R = Array.create('float', 9);
    const orientation = Array.create('float', 3);
    let last = 0;
    headingListener = new android.hardware.SensorEventListener({
      onAccuracyChanged() {},
      onSensorChanged(event: android.hardware.SensorEvent) {
        const now = java.lang.System.currentTimeMillis();
        if (now - last < minMs) return; // throttle emit to the requested Hz
        last = now;
        android.hardware.SensorManager.getRotationMatrixFromVector(R, event.values);
        android.hardware.SensorManager.getOrientation(R, orientation);
        // orientation[0] = azimuth in rad (−π..π), CCW from north. Convert to 0–360 compass degrees.
        const deg = ((orientation[0] * 180) / Math.PI + 360) % 360;
        bridge.emit('heading.data', { deg });
      },
    });
    const periodUs = Math.max(5000, Math.round(1_000_000 / hz));
    sm.registerListener(headingListener, rot, periodUs);
  });

  bridge.register('heading.stop', () => {
    if (headingListener) sensorManager().unregisterListener(headingListener);
    headingListener = null;
  });

  // ── contacts (ACTION_PICK + ContactsContract query) ────────────────
  bridge.register('contacts.pick', async () => {
    if (!(await requestPermissions(['android.permission.READ_CONTACTS']))) {
      throw err('DENIED', 'contacts permission denied');
    }
    const CC = android.provider.ContactsContract;
    const intent = new android.content.Intent(android.content.Intent.ACTION_PICK, CC.Contacts.CONTENT_URI);
    const { resultCode, intent: result } = await startActivityForResult(intent);
    if (resultCode !== android.app.Activity.RESULT_OK || !result?.getData()) return { picked: false };

    const cr = context().getContentResolver();
    const column = (uri: android.net.Uri, col: string, sel: string | null, args: string[] | null): string[] => {
      const out: string[] = [];
      const cursor = cr.query(uri, [col], sel, args, null);
      if (cursor) {
        const idx = cursor.getColumnIndex(col);
        while (cursor.moveToNext()) out.push(String(cursor.getString(idx)));
        cursor.close();
      }
      return out;
    };

    const contactId = column(result.getData(), CC.Contacts._ID, null, null)[0];
    const name = column(result.getData(), CC.Contacts.DISPLAY_NAME, null, null)[0] ?? '';
    if (!contactId) return { picked: true, name, phones: [], emails: [] };
    return {
      picked: true,
      name,
      phones: column(CC.CommonDataKinds.Phone.CONTENT_URI, CC.CommonDataKinds.Phone.NUMBER,
        CC.CommonDataKinds.Phone.CONTACT_ID + ' = ?', [contactId]),
      emails: column(CC.CommonDataKinds.Email.CONTENT_URI, CC.CommonDataKinds.Email.ADDRESS,
        CC.CommonDataKinds.Email.CONTACT_ID + ' = ?', [contactId]),
    };
  });

  // ── contacts bulk read (ContactsContract query over all contacts) ──
  bridge.register('contacts.getAll', async () => {
    if (!(await requestPermissions(['android.permission.READ_CONTACTS']))) {
      throw err('DENIED', 'contacts permission denied');
    }
    const CC = android.provider.ContactsContract;
    const cr = context().getContentResolver();
    const column = (uri: android.net.Uri, col: string, sel: string | null, args: string[] | null): string[] => {
      const out: string[] = [];
      const cursor = cr.query(uri, [col], sel, args, null);
      if (cursor) {
        const idx = cursor.getColumnIndex(col);
        while (cursor.moveToNext()) out.push(String(cursor.getString(idx)));
        cursor.close();
      }
      return out;
    };

    const contacts: Array<{ name: string; phones: string[]; emails: string[] }> = [];
    const cursor = cr.query(
      CC.Contacts.CONTENT_URI,
      [CC.Contacts._ID, CC.Contacts.DISPLAY_NAME],
      null, null, null
    );
    if (cursor) {
      const idIdx = cursor.getColumnIndex(CC.Contacts._ID);
      const nameIdx = cursor.getColumnIndex(CC.Contacts.DISPLAY_NAME);
      while (cursor.moveToNext()) {
        const contactId = String(cursor.getString(idIdx));
        const name = cursor.getString(nameIdx) ?? '';
        contacts.push({
          name,
          phones: column(CC.CommonDataKinds.Phone.CONTENT_URI, CC.CommonDataKinds.Phone.NUMBER,
            CC.CommonDataKinds.Phone.CONTACT_ID + ' = ?', [contactId]),
          emails: column(CC.CommonDataKinds.Email.CONTENT_URI, CC.CommonDataKinds.Email.ADDRESS,
            CC.CommonDataKinds.Email.CONTACT_ID + ' = ?', [contactId]),
        });
      }
      cursor.close();
    }
    return { contacts };
  });

  // ── calendar (CalendarContract direct insert) ──────────────────────
  bridge.register('calendar.createEvent', async ({ title, start, durationMin, notes }: any) => {
    if (!(await requestPermissions(['android.permission.WRITE_CALENDAR', 'android.permission.READ_CALENDAR']))) {
      throw err('DENIED', 'calendar permission denied');
    }
    const CalC = android.provider.CalendarContract;
    const cr = context().getContentResolver();
    const calCursor = cr.query(CalC.Calendars.CONTENT_URI, [CalC.Calendars._ID], null, null, null);
    let calId = -1;
    if (calCursor && calCursor.moveToFirst()) calId = calCursor.getLong(0);
    calCursor?.close();
    if (calId < 0) throw err('UNSUPPORTED', 'No calendar account on this device');

    const startMs = start ? Date.parse(start) : Date.now() + 3600_000;
    const endMs = startMs + (durationMin ?? 60) * 60_000;
    const values = new android.content.ContentValues();
    values.put('dtstart', java.lang.Long.valueOf(String(startMs)));
    values.put('dtend', java.lang.Long.valueOf(String(endMs)));
    values.put('title', String(title ?? 'Event'));
    if (notes) values.put('description', String(notes));
    values.put('calendar_id', java.lang.Long.valueOf(String(calId)));
    values.put('eventTimezone', java.util.TimeZone.getDefault().getID());
    const uri = cr.insert(CalC.Events.CONTENT_URI, values);
    return { id: uri ? String(android.content.ContentUris.parseId(uri)) : '' };
  });

  // ── camera capture (MediaStore image-capture, thumbnail result) ────
  bridge.register('camera.capture', async ({ dataUrl }: any = {}) => {
    if (!(await requestPermissions(['android.permission.CAMERA']))) {
      throw err('DENIED', 'camera permission denied');
    }
    const intent = new android.content.Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
    if (!intent.resolveActivity(context().getPackageManager())) {
      throw err('UNSUPPORTED', 'No camera app on this device');
    }
    const { resultCode, intent: result } = await startActivityForResult(intent);
    if (resultCode !== android.app.Activity.RESULT_OK) return { picked: false };
    const bmp = result?.getExtras()?.get('data'); // thumbnail Bitmap
    if (!bmp) return { picked: true };
    const out: any = { picked: true, width: bmp.getWidth(), height: bmp.getHeight() };
    if (dataUrl) out.dataUrl = bitmapToDataUrl(bmp);
    return out;
  });

  // ── file share (FileProvider content:// URIs + ACTION_SEND[_MULTIPLE]) ──
  bridge.register('share.files', ({ files, text, title }: { files: Array<{ name: string; mimeType: string; base64: string }>; text?: string; title?: string }) => {
    const ctx = context();
    const authority = ctx.getPackageName() + '.fileprovider';
    const dir = new java.io.File(ctx.getCacheDir(), 'shared');
    dir.mkdirs();
    const uris = new java.util.ArrayList();
    const mimes = new java.util.HashSet();
    (files ?? []).forEach((f: { name: string; mimeType: string; base64: string }, i: number) => {
      const bytes = android.util.Base64.decode(f.base64, android.util.Base64.DEFAULT);
      const out = new java.io.File(dir, i + '-' + (f.name || 'file')); // index-prefix: avoid same-name collisions
      const fos = new java.io.FileOutputStream(out);
      fos.write(bytes);
      fos.close();
      uris.add(androidx.core.content.FileProvider.getUriForFile(ctx, authority, out));
      if (f.mimeType) mimes.add(f.mimeType);
    });
    if (uris.size() === 0) return;
    const single = uris.size() === 1;
    const I = android.content.Intent;
    const intent = new I(single ? I.ACTION_SEND : I.ACTION_SEND_MULTIPLE);
    intent.setType(mimes.size() === 1 ? mimes.iterator().next() : 'application/octet-stream');
    if (single) intent.putExtra(I.EXTRA_STREAM, uris.get(0));
    else intent.putParcelableArrayListExtra(I.EXTRA_STREAM, uris);
    if (text) intent.putExtra(I.EXTRA_TEXT, String(text));
    if (title) intent.putExtra(I.EXTRA_SUBJECT, String(title));
    intent.addFlags(I.FLAG_GRANT_READ_URI_PERMISSION);
    const chooser = I.createChooser(intent, title ?? 'Share');
    chooser.addFlags(I.FLAG_ACTIVITY_NEW_TASK);
    ctx.startActivity(chooser);
  });

  // ── screen orientation (Activity.setRequestedOrientation) ──────────
  const SO = android.content.pm.ActivityInfo;
  const requestedOrientation = (o: string): number => {
    switch (o) {
      case 'portrait': return SO.SCREEN_ORIENTATION_PORTRAIT;
      case 'portrait-upside-down': return SO.SCREEN_ORIENTATION_REVERSE_PORTRAIT;
      case 'landscape': return SO.SCREEN_ORIENTATION_LANDSCAPE;
      case 'landscape-left': return SO.SCREEN_ORIENTATION_LANDSCAPE;
      case 'landscape-right': return SO.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;
      default: return SO.SCREEN_ORIENTATION_UNSPECIFIED;
    }
  };
  bridge.register('screen.orientation.lock', ({ orientation }: { orientation: string }) => {
    activity()?.setRequestedOrientation(requestedOrientation(String(orientation)));
  });
  bridge.register('screen.orientation.unlock', () => {
    activity()?.setRequestedOrientation(SO.SCREEN_ORIENTATION_UNSPECIFIED);
  });
}
