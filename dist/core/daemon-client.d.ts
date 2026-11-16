import type { ContextOffer, DaemonHealthStatus, KnowledgeWriteRequest } from './types.js';
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
export declare function validateDaemonEndpoint(rawUrl: string): URL;
export declare class ForewispDaemonClient {
    readonly endpoint: URL;
    private readonly token?;
    private readonly fetcher;
    constructor(options: {
        endpoint: string;
        token?: string;
        fetch?: typeof fetch;
    });
    private url;
    private headers;
    health(timeoutMs?: number): Promise<DaemonHealthStatus>;
    recall(query: string, opts?: {
        kinds?: readonly ('memory' | 'skill' | 'plugin')[];
        timeoutMs?: number;
        maxOffers?: number;
        inlineBytes?: number;
    }): Promise<{
        strategy: string;
        offers: ContextOffer[];
    }>;
    expand(id: string, timeoutMs?: number): Promise<{
        found: boolean;
        content?: string;
        version?: number;
    }>;
    contribute(req: KnowledgeWriteRequest, opts?: {
        timeoutMs?: number;
        reconcile?: boolean;
    }): Promise<{
        id: string;
        version: number;
        deduplicated: boolean;
    }>;
    observeEvent(sessionId: string, sequence: number, content: string, opts?: {
        kinds?: readonly ('memory' | 'skill' | 'plugin')[];
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<{
        accepted: boolean;
        sequence: number;
        reason?: string;
    }>;
    feedback(sessionId: string, offerId: string | number, entryId: string, verdict: ForewispVerdict, timeoutMs?: number): Promise<boolean>;
    offersStream(sessionId: string, signal: AbortSignal, cursor?: string): AsyncGenerator<DaemonOfferEvent>;
}
//# sourceMappingURL=daemon-client.d.ts.map