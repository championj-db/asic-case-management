import { getExecutionContext } from '@databricks/appkit';

const getWorkspaceClient = () => getExecutionContext().client;

/**
 * Foundation Model API chat completions against the configured serving endpoint (app resource `serving-endpoint`).
 * Model inference runs as the app service principal; callers must only pass context the user is entitled to see.
 */
export const LLM_ENDPOINT = process.env.DATABRICKS_SERVING_ENDPOINT_NAME || 'databricks-claude-sonnet-4-6';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function invoke(body: Record<string, unknown>): Promise<Response> {
  const client = getWorkspaceClient();
  const host = (await client.config.getHost()).toString().replace(/\/$/, '');
  const headers = new Headers({ 'Content-Type': 'application/json' });
  await client.config.authenticate(headers);
  const res = await fetch(`${host}/serving-endpoints/${LLM_ENDPOINT}/invocations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM endpoint ${LLM_ENDPOINT} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function chat(messages: ChatMessage[], maxTokens = 2000, temperature = 0.1): Promise<string> {
  const res = await invoke({ messages, max_tokens: maxTokens, temperature });
  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as unknown[]).map((c) => (typeof c === 'object' && c !== null && 'text' in c && typeof c.text === 'string' ? c.text : '')).join('');
  }
  return '';
}

/** Streams completion text deltas (OpenAI-compatible SSE from the serving endpoint). */
export async function* chatStream(messages: ChatMessage[], maxTokens = 4000): AsyncGenerator<string> {
  const res = await invoke({ messages, max_tokens: maxTokens, temperature: 0.1, stream: true });
  if (!res.body) return;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const delta = (JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
      } catch {
        // ignore keep-alives and partial frames
      }
    }
  }
}

/** GET a Databricks REST API as the app service principal (used for read-only metadata such as UC model versions). */
export async function apiGet<T>(path: string): Promise<T> {
  const client = getWorkspaceClient();
  const host = (await client.config.getHost()).toString().replace(/\/$/, '');
  const headers = new Headers();
  await client.config.authenticate(headers);
  const res = await fetch(`${host}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/** Extracts the first JSON object from a model reply (tolerates code fences). */
export function parseJsonReply<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
