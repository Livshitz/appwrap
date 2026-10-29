/** An http(s) URL on another origin than the shell's page (the in-app browser can't show other schemes). */
export function isOffsite(url: { scheme?: string; host?: string; port?: unknown } | null, page: { scheme?: string; host?: string; port?: unknown } | null): boolean {
  if (!url || !/^https?$/i.test(String(url.scheme ?? ''))) return false;
  if (!page) return true;
  return String(url.scheme).toLowerCase() !== String(page.scheme ?? '').toLowerCase() || String(url.host ?? '').toLowerCase() !== String(page.host ?? '').toLowerCase() || String(url.port ?? '') !== String(page.port ?? '');
}
