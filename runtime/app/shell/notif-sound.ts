/**
 * Custom notification sounds on iOS — turn a remote audio URL into something the OS will actually
 * ring.
 *
 * WHY THIS IS NOT JUST "pass the url": iOS never fetches a notification sound. `UNNotificationSound`
 * resolves a FILE NAME against the app bundle and the app container's `Library/Sounds/` directory,
 * and it will only play LinearPCM/MA4/µ-law/a-law wrapped in caf/aiff/wav, ≤30s. An mp3 from a sound
 * library — which is what a media search hands you — satisfies none of that, so a `sound: <url>`
 * option that merely forwards the string is a lie that fails silently at delivery time.
 *
 * So: download once, transcode with AVAudioFile (AVFoundation decodes mp3/ogg/wav on the way in and
 * writes LinearPCM on the way out — no ffmpeg, no server round-trip), trim to the OS ceiling, and
 * cache under a hash of the URL so the second notification is instant.
 *
 * Every failure path returns null, and the caller falls back to the DEFAULT alert sound — a wrong
 * ring is a cosmetic miss, but silence is the bug this whole lane exists to fix.
 */
import { sha256Hex } from './sha256';

// CoreAudioTypes isn't in the bundled iOS typings (AVFoundation is), so spell the one constant we
// need: kAudioFormatLinearPCM is the four-char code 'lpcm'. Declaring the literal beats referencing a
// whole framework's d.ts for a single integer.
const kAudioFormatLinearPCM = 0x6c70636d; // 'lpcm'

/** The OS ceiling for a notification sound. Longer audio is truncated, not rejected. */
const MAX_SECONDS = 30;
/** A sound is a one-shot alert, not a download: give up rather than hold the schedule call open. */
const FETCH_TIMEOUT_MS = 15_000;

/** `<app container>/Library/Sounds`, created on demand — the only writable dir UNNotificationSound reads. */
function soundsDir(): string | null {
  const libs = NSSearchPathForDirectoriesInDomains(
    NSSearchPathDirectory.LibraryDirectory, NSSearchPathDomainMask.UserDomainMask, true
  );
  if (!libs || libs.count === 0) return null;
  const dir = `${libs.objectAtIndex(0)}/Sounds`;
  const fm = NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(dir)) {
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, null);
  }
  return fm.fileExistsAtPath(dir) ? dir : null;
}

/** Download to a temp file. Resolves null on any transport failure (offline, 404, timeout). */
function download(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const nsUrl = NSURL.URLWithString(url);
    if (!nsUrl) return resolve(null);
    const cfg = NSURLSessionConfiguration.defaultSessionConfiguration;
    cfg.timeoutIntervalForRequest = FETCH_TIMEOUT_MS / 1000;
    const session = NSURLSession.sessionWithConfiguration(cfg);
    const task = session.downloadTaskWithURLCompletionHandler(nsUrl, (tmp, response, error) => {
      const status = (response as NSHTTPURLResponse)?.statusCode ?? 0;
      if (error || !tmp || (status && (status < 200 || status >= 300))) {
        console.warn(`[appwrap] notification sound download failed (${status || error?.localizedDescription})`);
        return resolve(null);
      }
      // The temp file is deleted the moment this handler returns, so copy it out synchronously.
      const keep = `${NSTemporaryDirectory()}appwrap-sound-${Date.now()}`;
      const fm = NSFileManager.defaultManager;
      if (fm.fileExistsAtPath(keep)) fm.removeItemAtPathError(keep, null);
      const ok = fm.copyItemAtPathToPathError(tmp.path, keep, null);
      resolve(ok ? keep : null);
    });
    task.resume();
  });
}

/**
 * Decode `srcPath` (any format AVFoundation reads) and write ≤30s of LinearPCM to `destPath` (.caf).
 * Returns false if either end refuses the file — a format AVFoundation can't open, or a settings
 * combination the writer rejects.
 */
function transcodeToCaf(srcPath: string, destPath: string): boolean {
  try {
    const src = AVAudioFile.alloc().initForReadingError(NSURL.fileURLWithPath(srcPath), null);
    if (!src) return false;
    const format = src.processingFormat;
    const frames = Math.min(Number(src.length), Math.floor(format.sampleRate * MAX_SECONDS));
    if (frames <= 0) return false;

    // Write settings mirror the source's rate/channels but force 16-bit LinearPCM — the writer
    // infers the container from the .caf extension.
    const settings = NSMutableDictionary.dictionaryWithDictionary(format.settings as never);
    settings.setObjectForKey(kAudioFormatLinearPCM, 'AVFormatIDKey');
    settings.setObjectForKey(16, 'AVLinearPCMBitDepthKey');
    settings.setObjectForKey(false, 'AVLinearPCMIsFloatKey');
    const fm = NSFileManager.defaultManager;
    if (fm.fileExistsAtPath(destPath)) fm.removeItemAtPathError(destPath, null);
    const dest = AVAudioFile.alloc().initForWritingSettingsError(
      NSURL.fileURLWithPath(destPath), settings as never, null
    );
    if (!dest) return false;

    // Stream in chunks: a 30s buffer at 48kHz stereo is ~11MB, and a notification sound is not worth
    // that resident all at once.
    const chunk = Math.floor(format.sampleRate); // ~1s
    let written = 0;
    while (written < frames) {
      const want = Math.min(chunk, frames - written);
      const buf = AVAudioPCMBuffer.alloc().initWithPCMFormatFrameCapacity(format, want);
      if (!buf) return false;
      if (!src.readIntoBufferFrameCountError(buf, want, null)) break;
      if (buf.frameLength === 0) break;
      if (!dest.writeFromBufferError(buf, null)) return false;
      written += buf.frameLength;
    }
    return written > 0 && fm.fileExistsAtPath(destPath);
  } catch (e) {
    console.warn('[appwrap] notification sound transcode failed:', String(e));
    return false;
  }
}

/**
 * Resolve a `sound` option to the FILE NAME UNNotificationSound wants, or null to fall back to the
 * default alert. A bare name (no scheme) is passed through untouched — that's a sound the app already
 * ships in its bundle, and it must not be treated as a URL.
 */
export async function resolveSoundName(sound: string): Promise<string | null> {
  const value = String(sound ?? '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return value;

  const dir = soundsDir();
  if (!dir) return null;
  const name = `appwrap-${sha256Hex(value).slice(0, 32)}.caf`;
  const dest = `${dir}/${name}`;
  // Cached from an earlier schedule — the common case once a timer app has fired once.
  if (NSFileManager.defaultManager.fileExistsAtPath(dest)) return name;

  const src = await download(value);
  if (!src) return null;
  const ok = transcodeToCaf(src, dest);
  NSFileManager.defaultManager.removeItemAtPathError(src, null);
  if (!ok) console.warn('[appwrap] notification sound unusable, falling back to the default alert');
  return ok ? name : null;
}
