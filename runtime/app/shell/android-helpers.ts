import { Application, Utils } from '@nativescript/core';

let nextCode = 7300;

function foregroundActivity() {
  return Application.android.foregroundActivity ?? Application.android.startActivity;
}

/** Request runtime permissions; resolves true when ALL are granted. Pre-granted short-circuits. */
export function requestPermissions(permissions: string[]): Promise<boolean> {
  const context = Utils.android.getApplicationContext();
  const granted = (p: string) =>
    context.checkSelfPermission(p) === android.content.pm.PackageManager.PERMISSION_GRANTED;
  if (permissions.every(granted)) return Promise.resolve(true);

  const activity = foregroundActivity();
  if (!activity) return Promise.resolve(false);

  const code = nextCode++;
  return new Promise((resolve) => {
    // interop: NS activity-event payload is dispatched untyped via Application.android.on
    const onResult = (args: any) => {
      if (args.requestCode !== code) return;
      Application.android.off(Application.android.activityRequestPermissionsEvent as any, onResult);
      const results: number[] = Array.from(args.grantResults ?? []);
      resolve(results.length > 0 && results.every((r) => r === android.content.pm.PackageManager.PERMISSION_GRANTED));
    };
    Application.android.on(Application.android.activityRequestPermissionsEvent as any, onResult);
    activity.requestPermissions(permissions, code);
  });
}

/** Decode a content Uri (downscaled to `maxSize` longest edge) into a JPEG data URL. */
export function uriToDataUrl(uri: android.net.Uri, maxSize: number): string | null {
  const cr = Utils.android.getApplicationContext().getContentResolver();
  const bounds = new android.graphics.BitmapFactory.Options();
  bounds.inJustDecodeBounds = true;
  let stream = cr.openInputStream(uri);
  android.graphics.BitmapFactory.decodeStream(stream, null, bounds);
  stream.close();

  const opts = new android.graphics.BitmapFactory.Options();
  let sample = 1;
  while (Math.max(bounds.outWidth, bounds.outHeight) / sample > maxSize) sample *= 2;
  opts.inSampleSize = sample;
  stream = cr.openInputStream(uri);
  const bmp = android.graphics.BitmapFactory.decodeStream(stream, null, opts);
  stream.close();
  return bmp ? bitmapToDataUrl(bmp) : null;
}

/** Compress an Android Bitmap to a JPEG data URL. */
export function bitmapToDataUrl(bmp: android.graphics.Bitmap): string {
  const baos = new java.io.ByteArrayOutputStream();
  bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, baos);
  const b64 = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP);
  return `data:image/jpeg;base64,${b64}`;
}

/** Launch an intent and resolve with its activity result. */
export function startActivityForResult(intent: android.content.Intent): Promise<{ resultCode: number; intent: android.content.Intent }> {
  const activity = foregroundActivity();
  if (!activity) return Promise.reject(Object.assign(new Error('no foreground activity'), { code: 'NOT_READY' }));

  const code = nextCode++;
  return new Promise((resolve) => {
    // interop: NS activity-event payload is dispatched untyped via Application.android.on
    const onResult = (args: any) => {
      if (args.requestCode !== code) return;
      Application.android.off(Application.android.activityResultEvent as any, onResult);
      resolve({ resultCode: args.resultCode, intent: args.intent });
    };
    Application.android.on(Application.android.activityResultEvent as any, onResult);
    activity.startActivityForResult(intent, code);
  });
}
