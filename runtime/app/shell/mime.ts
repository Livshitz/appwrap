/** Extension → MIME map shared by the iOS app:// handler and the Android asset interceptor. */
export const MIME: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  map: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  txt: 'text/plain',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

export function mimeFor(ext: string, fallbackPath = ''): string {
  return MIME[ext] ?? (fallbackPath.endsWith('.html') ? 'text/html' : 'application/octet-stream');
}
