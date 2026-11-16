import type { ContextBridgeOptions, ContextMode, KnowledgeWriteRequest, NsContextService, RetrievalResult, UpsertOutcome } from './types.js';
export declare class ForewispBridge implements NsContextService {
    readonly mode: ContextMode;
    private readonly workspaceRoot;
    private readonly dbPath;
    private readonly daemonUrl?;
    private readonly daemonToken?;
    private readonly inlineBytes;
    private readonly maxOffers;
    private readonly turn1TimeoutMs;
    private readonly db;
    private cachedDeps?;
    constructor(options: ContextBridgeOptions);
    private openDatabase;
    private safeJsonParse;
    private getDeps;
    private rowToRecord;
    private tryDaemonRetrieve;
    retrieve(query: string, conversationId?: string, opts?: {
        timeoutMs?: number;
    }): Promise<RetrievalResult>;
    markPresented(conversationId: string, entryIds: readonly string[]): void;
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
    feedback(id: string, helpful: boolean): Promise<{
        ok: boolean;
        helpful: number;
        harmful: number;
    }>;
    stats(): Promise<{
        entries: number;
        active: number;
        drifted: number;
        presentedCount: number;
    }>;
    close(): void;
}
//# sourceMappingURL=store.d.ts.map