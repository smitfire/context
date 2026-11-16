import { createHash } from 'node:crypto';
import type { ContextOffer, DaemonHealthStatus, KnowledgeWriteRequest } from './types.js';
import { containsSecrets, looksLikePromptInjection } from './validator.js';

export type ForewispVerdict = 'presented' | 'useful' | 'dismissed';

export interface DaemonOfferEvent {
  cursor: string;
  offerId: string;
  sessionId: string;
  sequence: number;
  strategy: string;
  entries: ContextOffer[];
  error?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function validateDaemonEndpoint(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || /[\r\n\0]/.test(rawUrl)) {
    throw new Error('Invalid FOREWISP_URL');
  }
  const url = new URL(rawUrl.trim());
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Forewisp endpoint requires HTTPS or loopback HTTP: ${url.origin}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Forewisp endpoint must not include credentials, query strings, or fragments');
  }
  return url;
}

function mapKindToForewisp(kind: KnowledgeWriteRequest['kind']): 'memory' | 'skill' | 'plugin' {
  if (kind === 'skill') return 'skill';
  if (kind === 'library') return 'plugin';
  return 'memory';
}

function mapScopeToForewisp(scope?: KnowledgeWriteRequest['scope']): 'private' | 'organization' | 'community' {
  if (scope === 'agent' || scope === 'user') return 'private';
  if (scope === 'public') return 'community';
  return 'organization';
}

function parseOfferEntry(raw: unknown, offerId?: string, sessionId?: string): ContextOffer | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(raw.id)) return null;
  const title = typeof raw.title === 'string' ? raw.title : '';
  const summary = typeof raw.summary === 'string' ? raw.summary : typeof raw.content === 'string' ? raw.content.slice(0, 400) : '';
  if (!title || !summary) return null;
  const inlineObj = isObject(raw.inline) && typeof raw.inline.content === 'string' ? raw.inline.content : undefined;
  const checkText = `${title}\n${summary}\n${inlineObj ?? ''}`;
  if (containsSecrets(checkText) || looksLikePromptInjection(checkText)) return null;

  const version = Number.isSafeInteger(raw.version) && Number(raw.version) >= 1 ? Number(raw.version) : 1;
  const inlineBody = inlineObj ?? (summary.length <= 460 ? summary : undefined);
  const expandBytes =
    typeof raw.material_bytes === 'number' && Number.isFinite(raw.material_bytes)
      ? raw.material_bytes
      : Buffer.byteLength(inlineObj ?? summary, 'utf8');

  return {
    id: raw.id,
    version,
    recordSha256: createHash('sha256').update(`${raw.id}:${version}:${summary}`).digest('hex'),
    kind: raw.kind === 'skill' ? 'skill' : raw.kind === 'plugin' ? 'plugin' : 'memory',
    scope: raw.scope === 'community' ? 'community' : 'organization',
    title,
    summary,
    ...(inlineBody ? { inlineBody } : {}),
    driftedFiles: [],
    score: 1,
    expandBytes,
    ...(offerId ? { offerId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export class ForewispDaemonClient {
  readonly endpoint: URL;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { endpoint: string; token?: string; fetch?: typeof fetch }) {
    this.endpoint = validateDaemonEndpoint(options.endpoint);
    if (options.token !== undefined && (!options.token.trim() || /[\r\n\0]/.test(options.token))) {
      throw new Error('Invalid FOREWISP_API_TOKEN');
    }
    this.token = options.token?.trim();
    this.fetcher = options.fetch ?? fetch;
  }

  private url(path: string): string {
    return new URL(path, this.endpoint).toString();
  }

  private headers(withJson = false): Record<string, string> {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(withJson ? { 'content-type': 'application/json' } : {}),
    };
  }

  async health(timeoutMs = 1000): Promise<DaemonHealthStatus> {
    try {
      const resp = await this.fetcher(this.url('/health'), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(100, timeoutMs)),
      });
      if (!resp.ok) {
        return { configured: true, reachable: false, error: `HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as Record<string, unknown>;
      return {
        configured: true,
        reachable: data.status === 'ok',
        strategy: typeof data.strategy === 'string' ? data.strategy : undefined,
        pilot: typeof data.pilot === 'boolean' ? data.pilot : undefined,
      };
    } catch (err) {
      return {
        configured: true,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async recall(
    query: string,
    opts: { kinds?: readonly ('memory' | 'skill' | 'plugin')[]; timeoutMs?: number; maxOffers?: number; inlineBytes?: number } = {},
  ): Promise<{ strategy: string; offers: ContextOffer[] }> {
    const resp = await this.fetcher(this.url('/v1/recall'), {
      method: 'POST',
      redirect: 'error',
      headers: this.headers(true),
      body: JSON.stringify({
        content: query.slice(0, 15_000),
        kinds: opts.kinds ?? ['memory', 'skill', 'plugin'],
      }),
      signal: AbortSignal.timeout(Math.max(150, opts.timeoutMs ?? 3000)),
    });
    if (!resp.ok) throw new Error(`Forewisp /v1/recall HTTP ${resp.status}`);
    const data = (await resp.json()) as { entries?: unknown[]; strategy?: unknown };
    if (!Array.isArray(data.entries)) throw new Error('Invalid Forewisp /v1/recall response');

    const maxOffers = opts.maxOffers ?? 3;
    const inlineBytes = opts.inlineBytes ?? 1800;
    const offers: ContextOffer[] = [];
    let usedBytes = 0;

    for (const raw of data.entries) {
      if (offers.length >= maxOffers) break;
      const offer = parseOfferEntry(raw);
      if (!offer) continue;
      const cost = Buffer.byteLength(offer.inlineBody ?? offer.summary, 'utf8');
      if (usedBytes + cost > inlineBytes && offers.length > 0) continue;
      offers.push(offer);
      usedBytes += cost;
    }

    return {
      strategy: typeof data.strategy === 'string' ? data.strategy : 'lexical',
      offers,
    };
  }

  async expand(id: string, timeoutMs = 3000): Promise<{ found: boolean; content?: string; version?: number }> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw new Error('Invalid Forewisp entry id');
    const resp = await this.fetcher(this.url(`/v1/entries/${encodeURIComponent(id)}`), {
      method: 'GET',
      redirect: 'error',
      headers: this.headers(false),
      signal: AbortSignal.timeout(Math.max(150, timeoutMs)),
    });
    if (resp.status === 404) return { found: false };
    if (!resp.ok) throw new Error(`Forewisp /v1/entries/${id} HTTP ${resp.status}`);
    const data = (await resp.json()) as { content?: unknown; version?: unknown };
    if (typeof data.content !== 'string') return { found: false };
    return {
      found: true,
      content: data.content,
      version: typeof data.version === 'number' ? data.version : 1,
    };
  }

  async contribute(
    req: KnowledgeWriteRequest,
    opts: { timeoutMs?: number; reconcile?: boolean } = {},
  ): Promise<{ id: string; version: number; deduplicated: boolean }> {
    const kind = mapKindToForewisp(req.kind);
    const scope = mapScopeToForewisp(req.scope);
    const applicabilityParts = [req.summary.trim(), req.keywords?.trim()].filter(Boolean);
    const payload = {
      kind,
      title: req.title.trim(),
      content: req.body.trim(),
      scope,
      applicability: applicabilityParts.join(' | ').slice(0, 1900),
      source: req.sourcePaths?.[0] ? `workspace://${req.sourcePaths[0]}` : 'ns-dsh://context',
      ...(kind === 'memory' && opts.reconcile ? { reconcile: true } : {}),
    };
    const resp = await this.fetcher(this.url('/v1/contributions'), {
      method: 'POST',
      redirect: 'error',
      headers: this.headers(true),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(250, opts.timeoutMs ?? 5000)),
    });
    if (!resp.ok) throw new Error(`Forewisp /v1/contributions HTTP ${resp.status}`);
    const data = (await resp.json()) as { entry?: { id?: unknown; version?: unknown }; deduplicated?: unknown };
    const id = typeof data.entry?.id === 'string' ? data.entry.id : '';
    const version = typeof data.entry?.version === 'number' ? data.entry.version : 1;
    if (!id) throw new Error('Invalid Forewisp /v1/contributions response');
    return { id, version, deduplicated: Boolean(data.deduplicated) };
  }

  async observeEvent(
    sessionId: string,
    sequence: number,
    content: string,
    opts: { kinds?: readonly ('memory' | 'skill' | 'plugin')[]; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ accepted: boolean; sequence: number; reason?: string }> {
    const timeoutSig = AbortSignal.timeout(Math.max(150, opts.timeoutMs ?? 3000));
    const signal = opts.signal ? AbortSignal.any([timeoutSig, opts.signal]) : timeoutSig;
    const resp = await this.fetcher(this.url('/v1/events'), {
      method: 'POST',
      redirect: 'error',
      headers: this.headers(true),
      body: JSON.stringify({
        session_id: sessionId.slice(0, 128),
        sequence,
        content: content.slice(0, 15_000),
        kinds: opts.kinds ?? ['memory', 'skill', 'plugin'],
      }),
      signal,
    });
    if (!resp.ok) throw new Error(`Forewisp /v1/events HTTP ${resp.status}`);
    const data = (await resp.json()) as { accepted?: unknown; sequence?: unknown; reason?: unknown };
    return {
      accepted: Boolean(data.accepted),
      sequence: typeof data.sequence === 'number' ? data.sequence : sequence,
      reason: typeof data.reason === 'string' ? data.reason : undefined,
    };
  }

  async feedback(
    sessionId: string,
    offerId: string | number,
    entryId: string,
    verdict: ForewispVerdict,
    timeoutMs = 2000,
  ): Promise<boolean> {
    const numOffer = Number(offerId);
    if (!Number.isSafeInteger(numOffer) || numOffer < 1) return false;
    const resp = await this.fetcher(this.url('/v1/feedback'), {
      method: 'POST',
      redirect: 'error',
      headers: this.headers(true),
      body: JSON.stringify({
        session_id: sessionId,
        offer_id: numOffer,
        entry_id: entryId,
        verdict,
      }),
      signal: AbortSignal.timeout(Math.max(150, timeoutMs)),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { recorded?: unknown };
    return data.recorded === true;
  }

  async *offersStream(
    sessionId: string,
    signal: AbortSignal,
    cursor?: string,
  ): AsyncGenerator<DaemonOfferEvent> {
    const resp = await this.fetcher(this.url(`/v1/sessions/${encodeURIComponent(sessionId)}/offers`), {
      method: 'GET',
      redirect: 'error',
      headers: {
        ...this.headers(false),
        accept: 'text/event-stream',
        ...(cursor ? { 'Last-Event-ID': cursor } : {}),
      },
      signal,
    });
    if (!resp.ok || !resp.body || !resp.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error(`Forewisp SSE stream unavailable (${resp.status})`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let scanFrom = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true }).replaceAll('\r', '');
        if (!chunk) continue;
        scanFrom = Math.max(0, buffer.length - 1);
        buffer += chunk;
        if (buffer.length > 256_000) throw new Error('Forewisp SSE frame exceeded 256KB');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n', scanFrom)) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          scanFrom = 0;
          const lines = frame.split('\n');
          const eventType = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
          const id = lines.find((l) => l.startsWith('id:'))?.slice(3).trim();
          if (eventType !== 'offer' || !id || !/^\d+$/.test(id)) continue;
          const dataStr = lines
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          const raw = JSON.parse(dataStr) as {
            id?: unknown;
            session_id?: unknown;
            sequence?: unknown;
            strategy?: unknown;
            entries?: unknown[];
            error?: unknown;
          };
          const offerId = String(raw.id ?? id);
          const sid = typeof raw.session_id === 'string' ? raw.session_id : sessionId;
          const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
          const entries = rawEntries
            .map((e) => parseOfferEntry(e, offerId, sid))
            .filter((e): e is ContextOffer => e !== null);
          yield {
            cursor: id,
            offerId,
            sessionId: sid,
            sequence: typeof raw.sequence === 'number' ? raw.sequence : 1,
            strategy: typeof raw.strategy === 'string' ? raw.strategy : 'lexical',
            entries,
            ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
          };
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
