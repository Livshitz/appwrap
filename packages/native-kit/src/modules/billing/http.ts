/** Shared HTTP helper for the backend-driven billing strategies (validator + web provider). */

export type HeaderProvider =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

export interface HttpJsonOptions {
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  headers?: HeaderProvider;
  /** Injected for tests / non-DOM runtimes. Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

/** POST/GET JSON, throwing on non-2xx. Keeps validators + providers DRY. */
export async function httpJson(opts: HttpJsonOptions): Promise<unknown> {
  const f = opts.fetch ?? globalThis.fetch;
  if (!f) throw new Error('billing: no fetch available — pass one via options.fetch');
  const h = typeof opts.headers === 'function' ? await opts.headers() : opts.headers;
  const res = await f(opts.url, {
    method: opts.method,
    headers: { 'content-type': 'application/json', ...(h ?? {}) },
    body: opts.method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
  });
  if (!res.ok) throw new Error(`billing: ${opts.method} ${opts.url} → ${res.status}`);
  return res.json();
}
