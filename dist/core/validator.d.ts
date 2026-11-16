import type { ContextEntryRecord, KnowledgeWriteRequest, ValidationIssue, WikiTraceApplicability, WorkspaceDependencies } from './types.js';
export declare const KNOWLEDGE_SCHEMA_ID = "forewisp.knowledge.v1";
export declare const MAX_TITLE_BYTES = 160;
export declare const MAX_SUMMARY_BYTES = 200;
export declare const MAX_BODY_BYTES: number;
export declare const MAX_KEYWORDS_BYTES = 1024;
export declare function containsSecrets(text: string): boolean;
export declare function looksLikePromptInjection(text: string): boolean;
export declare function computeRecordSha256(fields: {
    kind: string;
    scope: string;
    title: string;
    summary: string;
    body: string;
    keywords: string;
    sourceHashes: Record<string, string>;
    wikitrace: WikiTraceApplicability;
}): string;
export declare function hashWorkspaceFile(workspaceRoot: string, relPath: string): string | null;
export declare function detectDriftedFiles(workspaceRoot: string, sourceHashes: Record<string, string>, cache?: Map<string, string | null>): string[];
export declare function inspectWorkspaceDependencies(workspaceRoot: string): WorkspaceDependencies;
export declare function satisfiesSimpleReq(actualRaw: string, reqRaw: string): boolean;
export declare function isWikiTraceCompatible(entry: ContextEntryRecord, deps: WorkspaceDependencies): boolean;
export declare function validateKnowledgeWrite(req: KnowledgeWriteRequest, workspaceRoot: string): {
    issues: ValidationIssue[];
    normalizedSourceHashes: Record<string, string>;
};
//# sourceMappingURL=validator.d.ts.map