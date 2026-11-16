import { createHash } from 'node:crypto';
import { containsSecrets, looksLikePromptInjection } from './validator.js';
function isObject(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
export function validateDaemonEndpoint(rawUrl) {
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
function mapKindToForewisp(kind) {
    if (kind === 'skill')
        return 'skill';
    if (kind === 'library')
        return 'plugin';
    return 'memory';
}
function safeTimeoutSignal(ms, floor, fallback) {
    const raw = typeof ms === 'number' && Number.isFinite(ms) ? ms : fallback;
    return AbortSignal.timeout(Math.min(60_000, Math.max(floor, Math.trunc(raw))));
}
function mapScopeToForewisp(scope) {
    // Repository-local and personal entries map to 'private' on a remote daemon unless explicitly shared at org/public scope.
    if (scope === undefined || scope === 'agent' || scope === 'user' || scope === 'repository')
        return 'private';
    if (scope === 'organization')
        return 'organization';
    if (scope === 'public')
        return 'community';
    throw new Error(`Unsupported context scope for Forewisp daemon: ${String(scope)}`);
}
function parseOfferEntry(raw, offerId, sessionId) {
    if (!isObject(raw))
        return null;
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(raw.id))
        return null;
    const title = typeof raw.title === 'string' ? raw.title : '';
    const summary = typeof raw.summary === 'string' ? raw.summary : typeof raw.content === 'string' ? raw.content.slice(0, 400) : '';
    if (!title || !summary)
        return null;
    const inlineObj = isObject(raw.inline) && typeof raw.inline.content === 'string' ? raw.inline.content : undefined;
    const checkText = `${title}\n${summary}\n${inlineObj ?? ''}`;
    if (containsSecrets(checkText) || looksLikePromptInjection(checkText))
        return null;
    const version = Number.isSafeInteger(raw.version) && Number(raw.version) >= 1 ? Number(raw.version) : 1;
    const inlineBody = inlineObj ?? (summary.length <= 460 ? summary : undefined);
    const expandBytes = typeof raw.material_bytes === 'number' && Number.isFinite(raw.material_bytes)
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
    endpoint;
    token;
    fetcher;
    constructor(options) {
        this.endpoint = validateDaemonEndpoint(options.endpoint);
        if (options.token !== undefined && (!options.token.trim() || /[\r\n\0]/.test(options.token))) {
            throw new Error('Invalid FOREWISP_API_TOKEN');
        }
        this.token = options.token?.trim();
        this.fetcher = options.fetch ?? fetch;
    }
    url(path) {
        return new URL(path, this.endpoint).toString();
    }
    headers(withJson = false) {
        return {
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...(withJson ? { 'content-type': 'application/json' } : {}),
        };
    }
    async health(timeoutMs = 1000) {
        try {
            const resp = await this.fetcher(this.url('/health'), {
                method: 'GET',
                redirect: 'error',
                signal: safeTimeoutSignal(timeoutMs, 100, 1000),
            });
            if (!resp.ok) {
                return { configured: true, reachable: false, error: `HTTP ${resp.status}` };
            }
            const data = (await resp.json());
            return {
                configured: true,
                reachable: data.status === 'ok',
                strategy: typeof data.strategy === 'string' ? data.strategy : undefined,
                pilot: typeof data.pilot === 'boolean' ? data.pilot : undefined,
            };
        }
        catch (err) {
            return {
                configured: true,
                reachable: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    async recall(query, opts = {}) {
        const resp = await this.fetcher(this.url('/v1/recall'), {
            method: 'POST',
            redirect: 'error',
            headers: this.headers(true),
            body: JSON.stringify({
                content: query.slice(0, 15_000),
                kinds: opts.kinds ?? ['memory', 'skill', 'plugin'],
            }),
            signal: safeTimeoutSignal(opts.timeoutMs, 150, 3000),
        });
        if (!resp.ok)
            throw new Error(`Forewisp /v1/recall HTTP ${resp.status}`);
        const data = (await resp.json());
        if (!Array.isArray(data.entries))
            throw new Error('Invalid Forewisp /v1/recall response');
        const maxOffers = opts.maxOffers ?? 3;
        const inlineBytes = opts.inlineBytes ?? 1800;
        const offers = [];
        let usedBytes = 0;
        for (const raw of data.entries) {
            if (offers.length >= maxOffers)
                break;
            const offer = parseOfferEntry(raw);
            if (!offer)
                continue;
            let cost = Buffer.byteLength(offer.inlineBody ?? offer.summary, 'utf8');
            if (usedBytes + cost > inlineBytes) {
                if (offers.length > 0)
                    continue;
                // Clamp oversized first offer down to summary within byte budget rather than blowing inlineBytes.
                const maxFirst = Math.max(64, inlineBytes);
                if (Buffer.byteLength(offer.summary, 'utf8') <= maxFirst && offer.inlineBody) {
                    offer.inlineBody = offer.summary;
                }
                else {
                    offer.inlineBody = undefined;
                }
                cost = Buffer.byteLength(offer.inlineBody ?? offer.summary, 'utf8');
                if (cost > maxFirst)
                    continue;
            }
            offers.push(offer);
            usedBytes += cost;
        }
        return {
            strategy: typeof data.strategy === 'string' ? data.strategy : 'lexical',
            offers,
        };
    }
    async expand(id, timeoutMs = 3000) {
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id))
            throw new Error('Invalid Forewisp entry id');
        const resp = await this.fetcher(this.url(`/v1/entries/${encodeURIComponent(id)}`), {
            method: 'GET',
            redirect: 'error',
            headers: this.headers(false),
            signal: safeTimeoutSignal(timeoutMs, 150, 3000),
        });
        if (resp.status === 404)
            return { found: false };
        if (!resp.ok)
            throw new Error(`Forewisp /v1/entries/${id} HTTP ${resp.status}`);
        const data = (await resp.json());
        if (typeof data.content !== 'string')
            return { found: false };
        return {
            found: true,
            content: data.content,
            version: typeof data.version === 'number' ? data.version : 1,
        };
    }
    async contribute(req, opts = {}) {
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
            signal: safeTimeoutSignal(opts.timeoutMs, 250, 5000),
        });
        if (!resp.ok)
            throw new Error(`Forewisp /v1/contributions HTTP ${resp.status}`);
        const data = (await resp.json());
        const id = typeof data.entry?.id === 'string' ? data.entry.id : '';
        const version = typeof data.entry?.version === 'number' ? data.entry.version : 1;
        if (!id)
            throw new Error('Invalid Forewisp /v1/contributions response');
        return { id, version, deduplicated: Boolean(data.deduplicated) };
    }
    async observeEvent(sessionId, sequence, content, opts = {}) {
        const timeoutSig = safeTimeoutSignal(opts.timeoutMs, 150, 3000);
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
        if (!resp.ok)
            throw new Error(`Forewisp /v1/events HTTP ${resp.status}`);
        const data = (await resp.json());
        const ackSeq = Number.isSafeInteger(data.sequence) && Number(data.sequence) >= 0 ? Number(data.sequence) : sequence;
        return {
            accepted: Boolean(data.accepted),
            sequence: ackSeq,
            reason: typeof data.reason === 'string' ? data.reason : undefined,
        };
    }
    async feedback(sessionId, offerId, entryId, verdict, timeoutMs = 2000) {
        const rawOffer = String(offerId).trim();
        if (!/^\d+$/.test(rawOffer)) {
            throw new Error(`Invalid non-numeric Forewisp offer_id: ${rawOffer}`);
        }
        const numOffer = Number(rawOffer);
        if (!Number.isSafeInteger(numOffer) || numOffer < 1) {
            throw new Error(`Out-of-range Forewisp offer_id: ${rawOffer}`);
        }
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
            signal: safeTimeoutSignal(timeoutMs, 150, 3000),
        });
        if (!resp.ok)
            return false;
        const data = (await resp.json());
        return data.recorded === true;
    }
    async *offersStream(sessionId, signal, cursor) {
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
                if (done)
                    break;
                const chunk = decoder.decode(value, { stream: true }).replaceAll('\r', '');
                if (!chunk)
                    continue;
                scanFrom = Math.max(0, buffer.length - 1);
                buffer += chunk;
                if (buffer.length > 256_000)
                    throw new Error('Forewisp SSE frame exceeded 256KB');
                let boundary;
                while ((boundary = buffer.indexOf('\n\n', scanFrom)) >= 0) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    scanFrom = 0;
                    const lines = frame.split('\n');
                    const eventType = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
                    const id = lines.find((l) => l.startsWith('id:'))?.slice(3).trim();
                    if (eventType !== 'offer' || !id || !/^\d+$/.test(id))
                        continue;
                    const dataStr = lines
                        .filter((l) => l.startsWith('data:'))
                        .map((l) => l.slice(5).trimStart())
                        .join('\n');
                    let raw;
                    try {
                        raw = JSON.parse(dataStr);
                    }
                    catch {
                        continue;
                    }
                    const offerIdStr = raw.id !== undefined ? String(raw.id) : id;
                    if (!/^\d+$/.test(offerIdStr))
                        continue;
                    const sid = typeof raw.session_id === 'string' ? raw.session_id : sessionId;
                    const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
                    const entries = rawEntries
                        .map((e) => parseOfferEntry(e, offerIdStr, sid))
                        .filter((e) => e !== null);
                    yield {
                        cursor: id,
                        offerId: offerIdStr,
                        sessionId: sid,
                        sequence: typeof raw.sequence === 'number' ? raw.sequence : 1,
                        strategy: typeof raw.strategy === 'string' ? raw.strategy : 'lexical',
                        entries,
                        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
                    };
                }
            }
        }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    }
}
//# sourceMappingURL=daemon-client.js.map