import type { NativeKit } from '../core/NativeKit';

/** App-scoped storage roots — paths are resolved relative to one of these.
 *  - `documents`: user-visible (iOS Documents — iCloud-backed-up · Android getExternalFilesDir —
 *    NOT auto-backed-up, lives on shared/external storage).
 *  - `data`: app-private (iOS Application Support — backed up · Android getFilesDir — included in
 *    Auto Backup by default, subject to the app's backup rules). Default.
 *  - `cache`: evictable, the OS may purge it and it isn't backed up (iOS Caches · Android getCacheDir). */
export type FsDirectory = 'documents' | 'data' | 'cache';

/** Text vs binary payload encoding. `utf8` reads/writes a string; `base64` a raw byte blob. */
export type FsEncoding = 'utf8' | 'base64';

/** One entry returned by {@link FsModule.list} / {@link FsModule.stat}. */
export interface FsEntry {
  /** Base name (list) or full relative path (stat input echo). */
  name: string;
  type: 'file' | 'dir';
  /** Bytes for a file; omitted/0 for a dir. */
  size?: number;
  /** Last-modified epoch ms. */
  mtime?: number;
  /** Native URI (`file://` on native, omitted on web). */
  uri?: string;
}

/** A document chosen via {@link FsModule.pickFile}. `base64` carries the bytes inline. */
export interface PickedFile {
  name: string;
  mimeType: string;
  size: number;
  base64?: string;
}

export interface FsReadOptions { dir?: FsDirectory; encoding?: FsEncoding }
export interface FsWriteOptions { dir?: FsDirectory; encoding?: FsEncoding; recursive?: boolean }
export interface FsDirOptions { dir?: FsDirectory }
export interface FsMkdirOptions { dir?: FsDirectory; recursive?: boolean }
export interface FsPickOptions {
  /** MIME types / extensions to allow (e.g. `['application/pdf', 'image/*']`). Omit = any. */
  types?: string[];
  /** Allow multi-select (default false). */
  multiple?: boolean;
}

/**
 * Native filesystem + document picker — ONE API across platforms.
 *
 * Read/write/list/stat files under three app-scoped roots ({@link FsDirectory}) plus a system
 * document picker. No runtime permission is needed: every root lives inside the app sandbox and
 * the picker hands back security-scoped (iOS) / SAF (Android) URIs the user explicitly chose.
 *
 * Native (iOS `FileManager`, Android `java.io.File`) → `capability === 'native'`. Web maps file
 * I/O to the Origin Private File System (`'web'` where present, else `'none'`) and `pickFile` to
 * the File System Access API / a hidden `<input type=file>` fallback. Branch on {@link capability}.
 */
export class FsModule {
  constructor(private kit: NativeKit) {}

  /** 'native' on a shell · 'web' where OPFS exists · else 'none'. */
  get capability() {
    return this.kit.capability('fs');
  }

  /** Read a file. `utf8` (default) → string; `base64` → base64 string. */
  read(path: string, opts: FsReadOptions = {}): Promise<string> {
    return this.kit.invoke('fs.read', { path, ...opts });
  }

  /** Write `data` to `path` (overwrites). `recursive` creates missing parent dirs. → `{ uri }`. */
  write(path: string, data: string, opts: FsWriteOptions = {}): Promise<{ uri: string }> {
    return this.kit.invoke('fs.write', { path, data, ...opts });
  }

  /** Append `data` to `path` (creates it if absent). */
  append(path: string, data: string, opts: FsWriteOptions = {}): Promise<void> {
    return this.kit.invoke('fs.append', { path, data, ...opts });
  }

  /** Delete a file or empty directory. No-throw if it doesn't exist. */
  delete(path: string, opts: FsDirOptions = {}): Promise<void> {
    return this.kit.invoke('fs.delete', { path, ...opts });
  }

  /** List a directory's immediate children. */
  list(path: string, opts: FsDirOptions = {}): Promise<FsEntry[]> {
    return this.kit.invoke('fs.list', { path, ...opts });
  }

  /** Create a directory. `recursive` (default true) makes intermediate dirs. */
  mkdir(path: string, opts: FsMkdirOptions = {}): Promise<void> {
    return this.kit.invoke('fs.mkdir', { path, ...opts });
  }

  /** Stat a file/dir → `{ name, type, size, mtime, uri }`. */
  stat(path: string, opts: FsDirOptions = {}): Promise<FsEntry> {
    return this.kit.invoke('fs.stat', { path, ...opts });
  }

  /** Resolve a path to a URI suitable for `kit.share` (`file://` native, content:// Android). */
  getUri(path: string, opts: FsDirOptions = {}): Promise<string> {
    return this.kit.invoke('fs.getUri', { path, ...opts });
  }

  /** Open the system document picker. Resolves with the chosen files (bytes inline as base64). */
  pickFile(opts: FsPickOptions = {}): Promise<PickedFile[]> {
    return this.kit.invoke('fs.pickFile', opts);
  }
}
