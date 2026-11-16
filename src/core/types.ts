export type ContextKind = 'memory' | 'guidance' | 'skill' | 'library';
export type ContextScope = 'agent' | 'user' | 'repository' | 'organization' | 'public';
export type ContextMode = 'auto' | 'local' | 'daemon';

export interface WikiTraceApplicability {
  ecosystem?: 'node' | 'python' | 'rust' | 'polyglot';
  packages?: Record<string, string>;
  forbiddenImports?: string[];
  antiConditions?: string[];
}

export interface ContextEntryRecord {
  id: string;
  version: number;
  recordSha256: string;
  kind: ContextKind;
  scope: ContextScope;
  title: string;
  summary: string;
  body: string;
  keywords: string;
  sourceHashes: Record<string, string>;
  wikitrace: WikiTraceApplicability;
  helpful: number;
  harmful: number;
  withdrawn: boolean;
  updatedAt: number;
}

export interface KnowledgeWriteRequest {
  schema?: string;
  id?: string;
  kind: ContextKind;
  scope?: ContextScope;
  title: string;
  summary: string;
  body: string;
  keywords?: string;
  sourceHashes?: Record<string, string>;
  sourcePaths?: string[];
  wikitrace?: WikiTraceApplicability;
  baseRevision?: number;
  baseRecordSha256?: string;
  [extra: string]: unknown;
}

export interface ContextOffer {
  id: string;
  version: number;
  recordSha256: string;
  kind: ContextKind;
  scope: ContextScope;
  title: string;
  summary: string;
  inlineBody?: string;
  driftedFiles: string[];
  score: number;
  expandBytes: number;
}

export interface RetrievalResult {
  offers: ContextOffer[];
  latencyMs: number;
  tier: 'speed1_local' | 'daemon_v2';
  totalBytes: number;
}

export interface ValidationIssue {
  code:
    | 'SCHEMA_INVALID'
    | 'AUTHORITY_FIELD_REJECTED'
    | 'BYTE_LIMIT_EXCEEDED'
    | 'SECRET_DETECTED'
    | 'PROMPT_INJECTION_DETECTED'
    | 'SEMVER_INVALID'
    | 'SOURCE_PATH_INVALID'
    | 'SOURCE_DRIFTED';
  message: string;
}

export interface UpsertOutcome {
  ok: boolean;
  status: 'inserted' | 'updated' | 'conflict' | 'rejected';
  id?: string;
  version?: number;
  recordSha256?: string;
  reason?: string;
  issues?: ValidationIssue[];
}

export interface WorkspaceDependencies {
  ecosystems: Set<'node' | 'python' | 'rust'>;
  packages: Map<string, string>;
  imports: Set<string>;
}

export interface ContextBridgeOptions {
  workspaceRoot: string;
  dbPath?: string;
  mode?: ContextMode;
  daemonUrl?: string;
  daemonToken?: string;
  inlineBytes?: number;
  maxOffers?: number;
  turn1TimeoutMs?: number;
}

export interface NsContextService {
  readonly mode: ContextMode;
  retrieve(query: string, conversationId?: string, opts?: { timeoutMs?: number }): Promise<RetrievalResult>;
  expand(id: string, opts?: { allowStale?: boolean; offset?: number; limit?: number }): Promise<{
    found: boolean;
    stale: boolean;
    driftedFiles: string[];
    content?: string;
    totalBytes?: number;
    version?: number;
    recordSha256?: string;
  }>;
  upsert(req: KnowledgeWriteRequest): Promise<UpsertOutcome>;
  feedback(id: string, helpful: boolean): Promise<{ ok: boolean; helpful: number; harmful: number }>;
  markPresented(conversationId: string, entryIds: readonly string[]): void;
  stats(): Promise<{ entries: number; active: number; drifted: number; presentedCount: number }>;
}
