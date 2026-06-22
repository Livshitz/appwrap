import { Application, Utils } from '@nativescript/core';
import { bridge } from './bridge';
import { requestPermissions, startActivityForResult, uriToDataUrl, bitmapToDataUrl } from './android-helpers';

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

  const ensureChannel = () => {
    if (android.os.Build.VERSION.SDK_INT < 26) return;
    const channel = new android.app.NotificationChannel(
      CHANNEL_ID, 'Notifications', android.app.NotificationManager.IMPORTANCE_DEFAULT
    );
    notificationManager().createNotificationChannel(channel);
  };

  bridge.register('notifications.requestPermission', async () => {
    if (android.os.Build.VERSION.SDK_INT < 33) return 'granted';
    const ok = await requestPermissions(['android.permission.POST_NOTIFICATIONS']);
    return ok ? 'granted' : 'denied';
  });

  bridge.register('notifications.schedule', ({ id, title, body, delaySec, deepLink }: any) => {
    ensureChannel();
    const nid = id ?? Math.floor(Math.random() * 100000);
    const timer = setTimeout(() => {
      pendingTimers.delete(nid);
      const ctx = context();
      const builder = android.os.Build.VERSION.SDK_INT >= 26
        ? new android.app.Notification.Builder(ctx, CHANNEL_ID)
        : new android.app.Notification.Builder(ctx);
      builder
        .setSmallIcon(ctx.getApplicationInfo().icon)
        .setContentTitle(String(title ?? ''))
        .setAutoCancel(true);
      if (body) builder.setContentText(String(body));
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
      notificationManager().notify(nid, builder.build());
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

  bridge.register('biometrics.authenticate', ({ reason }: { reason?: string }) => {
    return new Promise((resolve, reject) => {
      Utils.dispatchToMainThread(() => {
        try {
          const act = activity(); // NativeScriptActivity extends AppCompatActivity → FragmentActivity
          const executor = androidx.core.content.ContextCompat.getMainExecutor(act);
          const Callback = (androidx.biometric.BiometricPrompt.AuthenticationCallback as any).extend({
            onAuthenticationSucceeded(_result: any) { resolve({ success: true }); },
            onAuthenticationError(_code: number, message: any) {
              reject(err('DENIED', String(message ?? 'authentication error')));
            },
          });
          const prompt = new androidx.biometric.BiometricPrompt(act, executor, new Callback());
          const info = new androidx.biometric.BiometricPrompt.PromptInfo.Builder()
            .setTitle(String(reason ?? 'Authenticate'))
            .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK)
            .setNegativeButtonText('Cancel')
            .build();
          prompt.authenticate(info);
        } catch (e: any) {
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

  bridge.register('motion.start', () => {
    if (motionListener) return; // already streaming
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
          // Android accelerometer already reports m/s² incl. gravity — kit contract matches.
          lastMotion.ax = v[0]; lastMotion.ay = v[1]; lastMotion.az = v[2];
        } else {
          lastMotion.rx = v[0]; lastMotion.ry = v[1]; lastMotion.rz = v[2];
        }
        const now = java.lang.System.currentTimeMillis();
        if (now - last < 100) return; // ~10Hz, matches iOS
        last = now;
        bridge.emit('motion.data', { ...lastMotion });
      },
    });
    const RATE = android.hardware.SensorManager.SENSOR_DELAY_GAME;
    sm.registerListener(motionListener, accel, RATE);
    if (gyro) sm.registerListener(motionListener, gyro, RATE);
  });

  bridge.register('motion.stop', () => {
    if (motionListener) sensorManager().unregisterListener(motionListener);
    motionListener = null;
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
