import type { ContextBridgeOptions, ContextMode, DaemonHealthStatus, KnowledgeWriteRequest, NsContextService, RetrievalResult, UpsertOutcome } from './types.js';
import { ForewispDaemonClient } from './daemon-client.js';
export declare class ForewispBridge implements NsContextService {
    readonly mode: ContextMode;
    private readonly workspaceRoot;
    private readonly dbPath;
    private readonly daemonUrl?;
    private readonly daemonToken?;
    private readonly inlineBytes;
    private readonly maxOffers;
    private readonly turn1TimeoutMs;
    private readonly daemon?;
    private readonly daemonOfferMeta;
    private readonly db;
    private cachedDeps?;
    constructor(options: ContextBridgeOptions);
    getDaemonClient(): ForewispDaemonClient | undefined;
    daemonHealth(): Promise<DaemonHealthStatus>;
    private openDatabase;
    private safeJsonParse;
    private getDeps;
    private rowToRecord;
    private tryDaemonRetrieve;
    retrieve(query: string, conversationId?: string, opts?: {
        timeoutMs?: number;
    }): Promise<RetrievalResult>;
    markPresented(conversationId: string, entryIds: readonly string[], opts?: {
        offerId?: string;
    }): void;
    expand(id: string, opts?: {
        allowStale?: boolean;
        offset?: number;
        limit?: number;
    }): Promise<{
        found: boolean;
        stale: boolean;
        driftedFiles: string[];
        content?: string;
        totalBytes?: number;
        version?: number;
        recordSha256?: string;
    }>;
    upsert(req: KnowledgeWriteRequest): Promise<UpsertOutcome>;
    private syncUpsertToDaemon;
    feedback(id: string, helpful: boolean, opts?: {
        conversationId?: string;
        offerId?: string;
    }): Promise<{
        ok: boolean;
        helpful: number;
        harmful: number;
        daemonRecorded?: boolean;
    }>;
    stats(): Promise<{
        entries: number;
        active: number;
        drifted: number;
        presentedCount: number;
        daemon: DaemonHealthStatus;
    }>;
    close(): void;
}
//# sourceMappingURL=store.d.ts.map