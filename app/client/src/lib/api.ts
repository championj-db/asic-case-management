import { useCallback, useEffect, useRef, useState } from 'react';

const PERSONA_KEY = 'asic.actingAs';

export const getPersona = () => localStorage.getItem(PERSONA_KEY) ?? '';
export const setPersona = (id: string) => localStorage.setItem(PERSONA_KEY, id);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const p = getPersona();
  if (p) h['x-acting-as'] = p;
  return h;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string; issues?: string[] };
      msg = j.issues?.length ? `${j.error}: ${j.issues.join('; ')}` : (j.error ?? msg);
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(url: string) => fetch(url, { headers: headers() }).then((r) => handle<T>(r)),
  post: <T>(url: string, body?: unknown) =>
    fetch(url, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body ?? {}) }).then((r) =>
      handle<T>(r),
    ),
  patch: <T>(url: string, body: unknown) =>
    fetch(url, { method: 'PATCH', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) }).then((r) => handle<T>(r)),
  upload: <T>(url: string, file: File, extra: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/octet-stream', 'x-filename': file.name, ...extra }),
      body: file,
    }).then((r) => handle<T>(r)),
  /** POST that returns server-sent events (brief generation). */
  stream: async (url: string, onEvent: (e: Record<string, unknown>) => void) => {
    const res = await fetch(url, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: '{}' });
    if (!res.ok || !res.body) {
      await handle<unknown>(res);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (line) onEvent(JSON.parse(line.slice(5)) as Record<string, unknown>);
      }
    }
  },
};

/** Minimal data hook: loading / error / data with reload. Keeps previous data while refreshing. */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(url));
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!url) return;
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .get<T>(url)
      .then((d) => {
        if (n === seq.current) setData(d);
      })
      .catch((e: Error) => {
        if (n === seq.current) setError(e.message);
      })
      .finally(() => {
        if (n === seq.current) setLoading(false);
      });
  }, [url]);
  useEffect(() => {
    // Fetching when the URL changes is this hook's purpose; loading state is set before the request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}
