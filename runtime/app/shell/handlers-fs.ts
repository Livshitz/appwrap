import { Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { startActivityForResult } from './android-helpers';

declare const android: any, java: any;

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

type Dir = 'documents' | 'data' | 'cache';

/** Strip a leading slash and reject any `..` segment so a path can't escape its sandbox root. */
function safeRelPath(path: string): string {
  const rel = String(path).replace(/^\/+/, '');
  if (rel.split('/').some((seg) => seg === '..')) throw err('NATIVE_ERROR', `Path traversal rejected: ${path}`);
  return rel;
}

/**
 * `kit.fs` shell handlers — app-sandbox file I/O + a system document picker, ONE API across iOS
 * and Android. No runtime permission: every root is inside the app sandbox and the picker returns
 * user-chosen security-scoped (iOS) / SAF (Android) URIs.
 *
 * iOS uses `FileManager` + `NSData`/`NSString`; dirs resolve via `NSSearchPathForDirectoriesInDomains`.
 * Android uses `java.io.File` under `getFilesDir()`/`getCacheDir()`/`getExternalFilesDir()`, the
 * existing share FileProvider for `getUri` content:// URIs, and `ACTION_OPEN_DOCUMENT` for the picker.
 *
 * DEVICE-GATED / UNVERIFIED this session: the iOS `UIDocumentPickerViewController` delegate and the
 * Android `ACTION_OPEN_DOCUMENT` activity-result plumbing (both async, new to the repo).
 */
export function registerFsHandlers(): void {
  if (isIOS) registerIosFs();
  else if (isAndroid) registerAndroidFs();
}

// ─────────────────────────────── iOS ───────────────────────────────

/** NSSearchPath domain index per dir; `documents`/`cache` are first-class, `data` → Application Support. */
function iosBaseDir(dir: Dir): string {
  // NSDocumentDirectory=9, NSCachesDirectory=13, NSApplicationSupportDirectory=14; NSUserDomainMask=1.
  const which = dir === 'documents' ? 9 : dir === 'cache' ? 13 : 14;
  const paths = NSSearchPathForDirectoriesInDomains(which as any, 1 as any, true);
  const base = paths.objectAtIndex(0) as string;
  // Application Support isn't auto-created; ensure it exists so `data` writes don't fail.
  if (which === 14) NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(base, true, null, null);
  return base;
}

function iosResolve(path: string, dir: Dir): string {
  return iosBaseDir(dir) + '/' + safeRelPath(path);
}

function registerIosFs(): void {
  const fm = () => NSFileManager.defaultManager;

  bridge.register('fs.read', ({ path, dir = 'data', encoding = 'utf8' }: any) => {
    const full = iosResolve(path, dir);
    if (!fm().fileExistsAtPath(full)) throw err('NATIVE_ERROR', `No such file: ${path}`);
    const data = NSData.dataWithContentsOfFile(full);
    if (!data) throw err('NATIVE_ERROR', `Read failed: ${path}`);
    if (encoding === 'base64') return data.base64EncodedStringWithOptions(0 as unknown as NSDataBase64EncodingOptions);
    return NSString.alloc().initWithDataEncoding(data, 4 /* NSUTF8StringEncoding */) as unknown as string;
  });

  bridge.register('fs.write', ({ path, data, dir = 'data', encoding = 'utf8', recursive }: any) => {
    const full = iosResolve(path, dir);
    if (recursive) ensureParentIos(full);
    const blob = encoding === 'base64'
      ? NSData.alloc().initWithBase64EncodedStringOptions(data, 0 as unknown as NSDataBase64DecodingOptions)
      : (NSString.stringWithString(String(data ?? '')) as any).dataUsingEncoding(4);
    if (!blob) throw err('NATIVE_ERROR', `Encode failed: ${path}`);
    if (!blob.writeToFileAtomically(full, true)) throw err('NATIVE_ERROR', `Write failed: ${path}`);
    return { uri: NSURL.fileURLWithPath(full).absoluteString };
  });

  bridge.register('fs.append', ({ path, data, dir = 'data', encoding = 'utf8' }: any) => {
    const full = iosResolve(path, dir);
    ensureParentIos(full);
    const blob = encoding === 'base64'
      ? NSData.alloc().initWithBase64EncodedStringOptions(data, 0 as unknown as NSDataBase64DecodingOptions)
      : (NSString.stringWithString(String(data ?? '')) as any).dataUsingEncoding(4);
    if (!blob) throw err('NATIVE_ERROR', `Encode failed: ${path}`);
    if (!fm().fileExistsAtPath(full)) {
      blob.writeToFileAtomically(full, true);
      return;
    }
    const handle = NSFileHandle.fileHandleForWritingAtPath(full);
    handle.seekToEndOfFile();
    handle.writeData(blob);
    handle.closeFile();
  });

  bridge.register('fs.delete', ({ path, dir = 'data' }: any) => {
    fm().removeItemAtPathError(iosResolve(path, dir), null); // no-throw if absent
  });

  bridge.register('fs.list', ({ path, dir = 'data' }: any) => {
    const full = iosResolve(path, dir);
    const names = fm().contentsOfDirectoryAtPathError(full, null);
    if (!names) throw err('NATIVE_ERROR', `No such dir: ${path}`);
    const out: any[] = [];
    for (let i = 0; i < names.count; i++) {
      const name = names.objectAtIndex(i) as string;
      out.push(iosStat(full + '/' + name, name));
    }
    return out;
  });

  bridge.register('fs.mkdir', ({ path, dir = 'data', recursive = true }: any) => {
    const ok = fm().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
      iosResolve(path, dir), recursive !== false, null, null
    );
    if (!ok) throw err('NATIVE_ERROR', `mkdir failed: ${path}`);
  });

  bridge.register('fs.stat', ({ path, dir = 'data' }: any) => {
    const full = iosResolve(path, dir);
    if (!fm().fileExistsAtPath(full)) throw err('NATIVE_ERROR', `No such path: ${path}`);
    return iosStat(full, path);
  });

  bridge.register('fs.getUri', ({ path, dir = 'data' }: any) =>
    NSURL.fileURLWithPath(iosResolve(path, dir)).absoluteString
  );

  bridge.register('fs.pickFile', ({ types, multiple }: any) => pickFileIos(types, !!multiple));
}

function ensureParentIos(full: string): void {
  const parent = (NSString.stringWithString(full) as any).stringByDeletingLastPathComponent;
  NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(parent, true, null, null);
}

function iosStat(full: string, name: string): any {
  const fm = NSFileManager.defaultManager;
  const isDirRef = new interop.Reference<boolean>(interop.types.bool, false);
  const exists = fm.fileExistsAtPathIsDirectory(full, isDirRef as any);
  const isDir = !!isDirRef.value;
  const attrs = exists ? fm.attributesOfItemAtPathError(full, null) : null;
  const size = attrs && !isDir ? Number(attrs.objectForKey(NSFileSize) ?? 0) : undefined;
  const modDate = attrs ? attrs.objectForKey(NSFileModificationDate) : null;
  const mtime = modDate ? Math.round(modDate.timeIntervalSince1970 * 1000) : undefined;
  return {
    name,
    type: isDir ? 'dir' : 'file',
    size,
    mtime,
    uri: NSURL.fileURLWithPath(full).absoluteString,
  };
}

/**
 * iOS document picker via UIDocumentPickerViewController. Reads each chosen URL's bytes (under a
 * security-scoped access window) and returns them base64-inline. DEVICE-GATED — the delegate
 * callbacks (didPickDocumentsAtURLs / wasCancelled) are not exercised in this session.
 */
function pickFileIos(types: string[] | undefined, multiple: boolean): Promise<any[]> {
  return new Promise((resolve, reject) => {
    Utils.dispatchToMainThread(() => {
      try {
        const utis = NSMutableArray.new();
        // Map common MIME/extension hints to UTTypes; default to "any item".
        (types ?? []).forEach((t) => {
          const ut = (UTType as any).typeWithMIMEType?.(t) ?? (UTType as any).typeWithFilenameExtension?.(t.replace(/^\./, ''));
          if (ut) utis.addObject(ut);
        });
        if (utis.count === 0) utis.addObject(UTTypeItem);

        const picker = UIDocumentPickerViewController.alloc().initForOpeningContentTypes(utis as any);
        picker.allowsMultipleSelection = multiple;

        const DelegateClass = (NSObject as any).extend(
          {
            documentPickerDidPickDocumentsAtURLs(_p: any, urls: any) {
              const out: any[] = [];
              for (let i = 0; i < urls.count; i++) {
                const url = urls.objectAtIndex(i);
                const scoped = url.startAccessingSecurityScopedResource?.();
                try {
                  const data = NSData.dataWithContentsOfURL(url);
                  if (data) {
                    out.push({
                      name: url.lastPathComponent,
                      mimeType: mimeForUrlIos(url),
                      size: data.length,
                      base64: data.base64EncodedStringWithOptions(0 as unknown as NSDataBase64EncodingOptions),
                    });
                  }
                } finally {
                  if (scoped) url.stopAccessingSecurityScopedResource?.();
                }
              }
              resolve(out);
            },
            documentPickerWasCancelled() {
              resolve([]);
            },
          },
          { protocols: [UIDocumentPickerDelegate] }
        );
        const delegate = DelegateClass.new();
        (picker as any)._appwrapDelegate = delegate; // retain past the present call
        picker.delegate = delegate;
        Utils.ios.getRootViewController().presentViewControllerAnimatedCompletion(picker, true, null);
      } catch (e: any) {
        reject(err('NATIVE_ERROR', e?.message ?? 'document picker failed'));
      }
    });
  });
}

function mimeForUrlIos(url: any): string {
  const ut = (UTType as any).typeWithFilenameExtension?.(url.pathExtension);
  return ut?.preferredMIMEType ?? 'application/octet-stream';
}

// ───────────────────────────── Android ─────────────────────────────

function androidBaseDir(dir: Dir): any {
  const ctx = Utils.android.getApplicationContext();
  if (dir === 'cache') return ctx.getCacheDir();
  if (dir === 'documents') return ctx.getExternalFilesDir(null) ?? ctx.getFilesDir();
  return ctx.getFilesDir(); // 'data'
}

function androidFile(path: string, dir: Dir): any {
  return new java.io.File(androidBaseDir(dir), safeRelPath(path));
}

function readBytesAndroid(file: any): any {
  const fis = new java.io.FileInputStream(file);
  const baos = new java.io.ByteArrayOutputStream();
  const buf = Array.create('byte', 8192);
  let n: number;
  while ((n = fis.read(buf)) !== -1) baos.write(buf, 0, n);
  fis.close();
  return baos.toByteArray();
}

function registerAndroidFs(): void {
  bridge.register('fs.read', ({ path, dir = 'data', encoding = 'utf8' }: any) => {
    const file = androidFile(path, dir);
    if (!file.exists()) throw err('NATIVE_ERROR', `No such file: ${path}`);
    const bytes = readBytesAndroid(file);
    if (encoding === 'base64') return android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
    return new java.lang.String(bytes, 'UTF-8').toString();
  });

  bridge.register('fs.write', ({ path, data, dir = 'data', encoding = 'utf8', recursive }: any) => {
    const file = androidFile(path, dir);
    if (recursive) file.getParentFile()?.mkdirs();
    writeAndroid(file, data, encoding, false);
    return { uri: android.net.Uri.fromFile(file).toString() };
  });

  bridge.register('fs.append', ({ path, data, dir = 'data', encoding = 'utf8' }: any) => {
    const file = androidFile(path, dir);
    file.getParentFile()?.mkdirs();
    writeAndroid(file, data, encoding, true);
  });

  bridge.register('fs.delete', ({ path, dir = 'data' }: any) => {
    androidFile(path, dir).delete(); // no-throw if absent
  });

  bridge.register('fs.list', ({ path, dir = 'data' }: any) => {
    const file = androidFile(path, dir);
    const children = file.listFiles();
    if (!children) throw err('NATIVE_ERROR', `No such dir: ${path}`);
    const out: any[] = [];
    for (let i = 0; i < children.length; i++) out.push(androidStat(children[i], children[i].getName()));
    return out;
  });

  bridge.register('fs.mkdir', ({ path, dir = 'data', recursive = true }: any) => {
    const file = androidFile(path, dir);
    const ok = recursive !== false ? file.mkdirs() : file.mkdir();
    if (!ok && !file.isDirectory()) throw err('NATIVE_ERROR', `mkdir failed: ${path}`);
  });

  bridge.register('fs.stat', ({ path, dir = 'data' }: any) => {
    const file = androidFile(path, dir);
    if (!file.exists()) throw err('NATIVE_ERROR', `No such path: ${path}`);
    return androidStat(file, path);
  });

  bridge.register('fs.getUri', ({ path, dir = 'data' }: any) => {
    // Hand out a content:// via the existing share FileProvider so other apps (kit.share) can read it.
    const ctx = Utils.android.getApplicationContext();
    const authority = ctx.getPackageName() + '.fileprovider';
    return androidx.core.content.FileProvider.getUriForFile(ctx, authority, androidFile(path, dir)).toString();
  });

  bridge.register('fs.pickFile', ({ types, multiple }: any) => pickFileAndroid(types, !!multiple));
}

function writeAndroid(file: any, data: string, encoding: string, append: boolean): void {
  const bytes = encoding === 'base64'
    ? android.util.Base64.decode(String(data ?? ''), android.util.Base64.DEFAULT)
    : new java.lang.String(String(data ?? '')).getBytes('UTF-8');
  const fos = new java.io.FileOutputStream(file, append);
  fos.write(bytes);
  fos.close();
}

function androidStat(file: any, name: string): any {
  const isDir = file.isDirectory();
  return {
    name,
    type: isDir ? 'dir' : 'file',
    size: isDir ? undefined : file.length(),
    mtime: file.lastModified(),
    uri: android.net.Uri.fromFile(file).toString(),
  };
}

/**
 * Android document picker via ACTION_OPEN_DOCUMENT (reuses the shared startActivityForResult).
 * Reads each chosen content:// URI's bytes via the ContentResolver and returns them base64-inline.
 * DEVICE-GATED — the activity-result plumbing is not exercised in this session.
 */
async function pickFileAndroid(types: string[] | undefined, multiple: boolean): Promise<any[]> {
  const intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
  intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
  intent.setType((types && types.length === 1) ? types[0] : '*/*');
  if (types && types.length > 1) {
    // EXTRA_MIME_TYPES needs a Java String[]; NativeScript won't auto-marshal a JS array here.
    const arr = Array.create('java.lang.String', types.length);
    types.forEach((t, i) => { arr[i] = t; });
    intent.putExtra(android.content.Intent.EXTRA_MIME_TYPES, arr);
  }
  if (multiple) intent.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);

  const { resultCode, intent: result } = await startActivityForResult(intent);
  if (resultCode !== android.app.Activity.RESULT_OK || !result) return [];

  const uris: any[] = [];
  const clip = result.getClipData?.();
  if (clip) for (let i = 0; i < clip.getItemCount(); i++) uris.push(clip.getItemAt(i).getUri());
  else if (result.getData()) uris.push(result.getData());

  const cr = Utils.android.getApplicationContext().getContentResolver();
  return uris.map((uri) => {
    const stream = cr.openInputStream(uri);
    const baos = new java.io.ByteArrayOutputStream();
    const buf = Array.create('byte', 8192);
    let n: number;
    while ((n = stream.read(buf)) !== -1) baos.write(buf, 0, n);
    stream.close();
    const bytes = baos.toByteArray();
    return {
      name: queryDisplayName(cr, uri),
      mimeType: cr.getType(uri) ?? 'application/octet-stream',
      size: bytes.length,
      base64: android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP),
    };
  });
}

function queryDisplayName(cr: any, uri: any): string {
  const cursor = cr.query(uri, [android.provider.OpenableColumns.DISPLAY_NAME], null, null, null);
  let name = 'file';
  if (cursor) {
    if (cursor.moveToFirst()) name = String(cursor.getString(0) ?? 'file');
    cursor.close();
  }
  return name;
}
