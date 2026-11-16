import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ContextBridgeOptions,
  ContextEntryRecord,
  ContextMode,
  ContextOffer,
  KnowledgeWriteRequest,
  NsContextService,
  RetrievalResult,
  UpsertOutcome,
} from './types.js';
import {
  computeRecordSha256,
  containsSecrets,
  detectDriftedFiles,
  inspectWorkspaceDependencies,
  isWikiTraceCompatible,
  looksLikePromptInjection,
  validateKnowledgeWrite,
} from './validator.js';

const LOCAL_SCHEMA_VERSION = 5;

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [])];
}

function buildFtsQuery(text: string): string {
  const tokens = tokenize(text).slice(0, 24);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

export class ForewispBridge implements NsContextService {
  readonly mode: ContextMode;
  private readonly workspaceRoot: string;
  private readonly dbPath: string;
  private readonly daemonUrl?: string;
  private readonly daemonToken?: string;
  private readonly inlineBytes: number;
  private readonly maxOffers: number;
  private readonly turn1TimeoutMs: number;
  private readonly db: DatabaseSync;
  private cachedDeps?: { deps: ReturnType<typeof inspectWorkspaceDependencies>; at: number };

  constructor(options: ContextBridgeOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.dbPath = resolve(options.dbPath ?? join(this.workspaceRoot, '.forewisp', 'local.db'));
    this.mode = options.mode ?? 'auto';
    this.daemonUrl = options.daemonUrl ?? process.env.FOREWISP_URL;
    this.daemonToken = options.daemonToken ?? process.env.FOREWISP_API_TOKEN;
    this.inlineBytes = options.inlineBytes ?? 1800;
    this.maxOffers = options.maxOffers ?? 3;
    this.turn1TimeoutMs = options.turn1TimeoutMs ?? 50;
    this.db = this.openDatabase();
  }

  private openDatabase(): DatabaseSync {
    const dir = dirname(this.dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.dbPath) && lstatSync(this.dbPath).isSymbolicLink()) {
      throw new Error(`refusing symlinked SQLite database: ${this.dbPath}`);
    }
    const db = new DatabaseSync(this.dbPath);
    chmodSync(this.dbPath, 0o600);
    db.exec(`
      PRAGMA busy_timeout = 2000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        record_sha256 TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'repository',
        owner TEXT NOT NULL DEFAULT '',
        organization TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '',
        source_hashes TEXT NOT NULL DEFAULT '{}',
        wikitrace_json TEXT NOT NULL DEFAULT '{}',
        helpful INTEGER NOT NULL DEFAULT 1,
        harmful INTEGER NOT NULL DEFAULT 0,
        withdrawn INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        id UNINDEXED,
        title,
        summary,
        body,
        keywords
      );
      CREATE TABLE IF NOT EXISTS session_seen (
        conversation_id TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        presented_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, entry_key)
      );
      CREATE TABLE IF NOT EXISTS delivery_log (
        offer_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        query_text TEXT NOT NULL,
        selected_keys TEXT NOT NULL,
        injected_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        speed_tier TEXT NOT NULL DEFAULT 'speed1_local',
        ambiguity_reasons TEXT NOT NULL DEFAULT '[]',
        query_latency_ms REAL NOT NULL DEFAULT 0.0
      );
    `);
    const cols = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'record_sha256')) {
      db.exec("ALTER TABLE entries ADD COLUMN record_sha256 TEXT NOT NULL DEFAULT ''");
    }
    const verRow = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if ((verRow?.user_version ?? 0) < LOCAL_SCHEMA_VERSION) {
      db.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
    }
    return db;
  }

  private safeJsonParse<T>(raw: unknown, fallback: T): T {
    if (typeof raw !== 'string' || !raw.trim()) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private getDeps() {
    const now = Date.now();
    if (this.cachedDeps && now - this.cachedDeps.at < 10_000) return this.cachedDeps.deps;
    const deps = inspectWorkspaceDependencies(this.workspaceRoot);
    this.cachedDeps = { deps, at: now };
    return deps;
  }

  private rowToRecord(row: Record<string, unknown>): ContextEntryRecord {
    const sourceHashes = this.safeJsonParse<Record<string, string>>(row.source_hashes, {});
    const wikitrace = this.safeJsonParse(row.wikitrace_json, {});
    const recordSha256 =
      String(row.record_sha256 || '') ||
      computeRecordSha256({
        kind: String(row.kind),
        scope: String(row.scope),
        title: String(row.title),
        summary: String(row.summary),
        body: String(row.body),
        keywords: String(row.keywords || ''),
        sourceHashes,
        wikitrace,
      });
    return {
      id: String(row.id),
      version: Number(row.version ?? 1),
      recordSha256,
      kind: String(row.kind) as ContextEntryRecord['kind'],
      scope: String(row.scope) as ContextEntryRecord['scope'],
      title: String(row.title),
      summary: String(row.summary),
      body: String(row.body),
      keywords: String(row.keywords || ''),
      sourceHashes,
      wikitrace,
      helpful: Number(row.helpful ?? 1),
      harmful: Number(row.harmful ?? 0),
      withdrawn: Number(row.withdrawn ?? 0) === 1,
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  private async tryDaemonRetrieve(query: string, timeoutMs: number): Promise<RetrievalResult | null> {
    if (this.mode === 'local' || !this.daemonUrl) return null;
    try {
      const parsed = new URL(this.daemonUrl);
      const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) return null;
      const resp = await fetch(`${this.daemonUrl.replace(/\/$/, '')}/v1/events`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          ...(this.daemonToken ? { authorization: `Bearer ${this.daemonToken}` } : {}),
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(Math.max(50, timeoutMs)),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { offers?: unknown[] };
      if (!Array.isArray(data.offers)) return null;
      const validOffers = data.offers.filter(
        (o): o is ContextOffer =>
          typeof o === 'object' &&
          o !== null &&
          typeof (o as ContextOffer).id === 'string' &&
          typeof (o as ContextOffer).summary === 'string' &&
          !containsSecrets(`${(o as ContextOffer).title ?? ''}\n${(o as ContextOffer).summary}\n${(o as ContextOffer).inlineBody ?? ''}`) &&
          !looksLikePromptInjection(`${(o as ContextOffer).title ?? ''}\n${(o as ContextOffer).summary}\n${(o as ContextOffer).inlineBody ?? ''}`),
      );
      const totalBytes = validOffers.reduce(
        (acc, o) => acc + Buffer.byteLength(typeof o.inlineBody === 'string' ? o.inlineBody : o.summary, 'utf8'),
        0,
      );
      return { offers: validOffers.slice(0, this.maxOffers), latencyMs: 0, tier: 'daemon_v2', totalBytes };
    } catch {
      return null;
    }
  }

  async retrieve(query: string, conversationId = 'default', opts?: { timeoutMs?: number }): Promise<RetrievalResult> {
    const started = performance.now();
    if (this.mode === 'daemon') {
      const remote = await this.tryDaemonRetrieve(query, opts?.timeoutMs ?? 1500);
      if (remote) {
        remote.latencyMs = Number((performance.now() - started).toFixed(2));
        return remote;
      }
      return { offers: [], latencyMs: Number((performance.now() - started).toFixed(2)), tier: 'daemon_v2', totalBytes: 0 };
    }

    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return { offers: [], latencyMs: Number((performance.now() - started).toFixed(2)), tier: 'speed1_local', totalBytes: 0 };
    }

    const seenRows = this.db
      .prepare('SELECT entry_key FROM session_seen WHERE conversation_id = ?')
      .all(conversationId) as Array<{ entry_key: string }>;
    const seen = new Set(seenRows.map((r) => `${r.entry_key}`));

    let rawRows: Array<Record<string, unknown>> = [];
    try {
      rawRows = this.db
        .prepare(
          `SELECT e.*, -bm25(entries_fts, 3.0, 2.0, 1.0, 2.5) AS fts_score
           FROM entries_fts f
           JOIN entries e ON e.id = f.id
           WHERE entries_fts MATCH ? AND e.withdrawn = 0
           ORDER BY fts_score DESC
           LIMIT 32`,
        )
        .all(ftsQuery) as Array<Record<string, unknown>>;
    } catch {
      rawRows = [];
    }

    if (rawRows.length === 0 && this.mode === 'auto' && this.daemonUrl) {
      const remote = await this.tryDaemonRetrieve(query, opts?.timeoutMs ?? Math.max(this.turn1TimeoutMs, 1200));
      if (remote && remote.offers.length > 0) {
        remote.latencyMs = Number((performance.now() - started).toFixed(2));
        return remote;
      }
    }

    const hasWikiConstraints = rawRows.some((r) => typeof r.wikitrace_json === 'string' && r.wikitrace_json !== '{}' && r.wikitrace_json.length > 2);
    const deps = hasWikiConstraints ? this.getDeps() : null;
    const nowSec = Math.floor(Date.now() / 1000);
    const fileHashCache = new Map<string, string | null>();
    const scored: Array<{ offer: ContextOffer; tokens: Set<string> }> = [];

    for (const row of rawRows) {
      const entry = this.rowToRecord(row);
      const seenKey = `${entry.id}:${entry.version}`;
      if (seen.has(seenKey) || seen.has(entry.id)) continue;
      if (looksLikePromptInjection(`${entry.title}\n${entry.summary}\n${entry.body}`)) continue;
      if (containsSecrets(`${entry.title}\n${entry.summary}\n${entry.body}`)) continue;
      if (deps && !isWikiTraceCompatible(entry, deps)) continue;

      // Guard against negative SQLite BM25 IDF on tiny (1-2 row) FTS5 tables by blending token overlap.
      const queryTokens = tokenize(query);
      const entryTokens = new Set(tokenize(`${entry.title} ${entry.summary} ${entry.keywords} ${entry.body}`));
      const overlap = queryTokens.length === 0
        ? 0
        : queryTokens.filter((t) => entryTokens.has(t)).length / queryTokens.length;
      if (overlap === 0 && Number(row.fts_score ?? 0) <= 0) continue;

      const driftedFiles =
        Object.keys(entry.sourceHashes).length === 0 || fileHashCache.size >= 64
          ? []
          : detectDriftedFiles(this.workspaceRoot, entry.sourceHashes, fileHashCache);
      // 90-day half-life Beta(1,1) posterior weighting.
      const ageDays = Math.max(0, (nowSec - entry.updatedAt) / 86400);
      const decay = Math.pow(0.5, ageDays / 90);
      const posterior = (1 + entry.helpful * decay) / (2 + (entry.helpful + entry.harmful) * decay);
      const ftsScore = Math.max(0, Number(row.fts_score ?? 0));
      const baseRelevance = Math.max(overlap, Math.min(2, ftsScore) * 0.5 + overlap * 0.5);
      const driftPenalty = driftedFiles.length > 0 ? 0.35 : 1.0;
      const finalScore = baseRelevance * (0.5 + posterior) * driftPenalty;
      if (finalScore <= 0.1) continue;

      const inlineBody =
        driftedFiles.length > 0
          ? `[STALE_WARNING: Referenced file(s) ${driftedFiles.join(', ')} modified since capture; verify before applying.]`
          : entry.body.length <= 460
            ? entry.body
            : `${entry.summary}\n(Expand ${entry.id} for ${Buffer.byteLength(entry.body, 'utf8')}B)`;

      scored.push({
        offer: {
          id: entry.id,
          version: entry.version,
          recordSha256: entry.recordSha256,
          kind: entry.kind,
          scope: entry.scope,
          title: entry.title,
          summary: entry.summary,
          inlineBody,
          driftedFiles,
          score: Number(finalScore.toFixed(4)),
          expandBytes: Buffer.byteLength(entry.body, 'utf8'),
        },
        tokens: new Set(tokenize(`${entry.title} ${entry.summary} ${entry.keywords}`)),
      });
    }

    // Submodular token-novelty diversity + byte knapsack packing.
    scored.sort((a, b) => b.offer.score - a.offer.score);
    const chosen: ContextOffer[] = [];
    const chosenTokenSets: Set<string>[] = [];
    let usedBytes = 0;

    for (const candidate of scored) {
      if (chosen.length >= this.maxOffers) break;
      const isNearDuplicate = chosenTokenSets.some((s) => jaccardOverlap(s, candidate.tokens) > 0.72);
      if (isNearDuplicate) continue;
      const cost = Buffer.byteLength(candidate.offer.inlineBody ?? candidate.offer.summary, 'utf8');
      if (usedBytes + cost > this.inlineBytes && chosen.length > 0) continue;
      chosen.push(candidate.offer);
      chosenTokenSets.push(candidate.tokens);
      usedBytes += cost;
    }

    const latencyMs = Number((performance.now() - started).toFixed(2));
    if (chosen.length > 0) {
      this.db
        .prepare(
          `INSERT INTO delivery_log (offer_id, conversation_id, query_text, selected_keys, injected_bytes, created_at, speed_tier, query_latency_ms)
           VALUES (?, ?, ?, ?, ?, ?, 'speed1_local', ?)`,
        )
        .run(
          randomUUID(),
          conversationId,
          query.slice(0, 500),
          JSON.stringify(chosen.map((c) => `${c.id}:${c.version}`)),
          usedBytes,
          nowSec,
          latencyMs,
        );
    }

    return { offers: chosen, latencyMs, tier: 'speed1_local', totalBytes: usedBytes };
  }

  markPresented(conversationId: string, entryIds: readonly string[]): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO session_seen (conversation_id, entry_key, presented_at) VALUES (?, ?, ?)',
    );
    for (const key of entryIds) stmt.run(conversationId, key, nowSec);
  }

  async expand(
    id: string,
    opts?: { allowStale?: boolean; offset?: number; limit?: number },
  ): Promise<{
    found: boolean;
    stale: boolean;
    driftedFiles: string[];
    content?: string;
    totalBytes?: number;
    version?: number;
    recordSha256?: string;
  }> {
    const row = this.db
      .prepare('SELECT * FROM entries WHERE id = ? AND withdrawn = 0')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return { found: false, stale: false, driftedFiles: [] };
    const entry = this.rowToRecord(row);
    const driftedFiles = detectDriftedFiles(this.workspaceRoot, entry.sourceHashes);
    if (driftedFiles.length > 0 && opts?.allowStale !== true) {
      return {
        found: true,
        stale: true,
        driftedFiles,
        version: entry.version,
        recordSha256: entry.recordSha256,
      };
    }
    const bodyBuf = Buffer.from(entry.body, 'utf8');
    const offset = Math.max(0, Math.min(bodyBuf.length, opts?.offset ?? 0));
    const limit = Math.min(32768, Math.max(256, opts?.limit ?? 8192));
    // Avoid splitting UTF-8 multi-byte sequences on page boundaries.
    let end = Math.min(bodyBuf.length, offset + limit);
    while (end > offset && end < bodyBuf.length && (bodyBuf[end] & 0xc0) === 0x80) end -= 1;
    let start = offset;
    while (start > 0 && start < bodyBuf.length && (bodyBuf[start] & 0xc0) === 0x80) start -= 1;
    return {
      found: true,
      stale: driftedFiles.length > 0,
      driftedFiles,
      content: bodyBuf.subarray(start, end).toString('utf8'),
      totalBytes: bodyBuf.length,
      version: entry.version,
      recordSha256: entry.recordSha256,
    };
  }

  async upsert(req: KnowledgeWriteRequest): Promise<UpsertOutcome> {
    const { issues, normalizedSourceHashes } = validateKnowledgeWrite(req, this.workspaceRoot);
    if (issues.length > 0) {
      return { ok: false, status: 'rejected', reason: issues[0].message, issues };
    }

    const scope = req.scope ?? 'repository';
    const keywords = req.keywords?.trim() ?? '';
    const wikitrace = req.wikitrace ?? {};
    const recordSha256 = computeRecordSha256({
      kind: req.kind,
      scope,
      title: req.title.trim(),
      summary: req.summary.trim(),
      body: req.body.trim(),
      keywords,
      sourceHashes: normalizedSourceHashes,
      wikitrace,
    });

    const deterministicId =
      req.id?.trim() ||
      `wisp_${createHash('sha256').update(`${req.kind}:${scope}:${req.title.trim()}`).digest('hex').slice(0, 12)}`;
    const nowSec = Math.floor(Date.now() / 1000);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existingRow = this.db
        .prepare('SELECT * FROM entries WHERE id = ?')
        .get(deterministicId) as Record<string, unknown> | undefined;

      if (existingRow) {
        const current = this.rowToRecord(existingRow);
        if (
          (req.baseRevision !== undefined && req.baseRevision !== current.version) ||
          (req.baseRecordSha256 !== undefined && req.baseRecordSha256 !== current.recordSha256)
        ) {
          this.db.exec('ROLLBACK');
          return {
            ok: false,
            status: 'conflict',
            id: current.id,
            version: current.version,
            recordSha256: current.recordSha256,
            reason: `knowledge_revision_conflict: expected v${req.baseRevision ?? '?'} (${req.baseRecordSha256 ?? '?'})`,
          };
        }
        const nextVer = current.version + 1;
        this.db
          .prepare(
            `UPDATE entries
             SET version = ?, record_sha256 = ?, kind = ?, scope = ?, title = ?, summary = ?, body = ?, keywords = ?,
                 source_hashes = ?, wikitrace_json = ?, withdrawn = 0, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            nextVer,
            recordSha256,
            req.kind,
            scope,
            req.title.trim(),
            req.summary.trim(),
            req.body.trim(),
            keywords,
            JSON.stringify(normalizedSourceHashes),
            JSON.stringify(wikitrace),
            nowSec,
            deterministicId,
          );
        this.db.prepare('DELETE FROM entries_fts WHERE id = ?').run(deterministicId);
        this.db
          .prepare('INSERT INTO entries_fts (id, title, summary, body, keywords) VALUES (?, ?, ?, ?, ?)')
          .run(deterministicId, req.title.trim(), req.summary.trim(), req.body.trim(), keywords);
        this.db.exec('COMMIT');
        return { ok: true, status: 'updated', id: deterministicId, version: nextVer, recordSha256 };
      }

      this.db
        .prepare(
          `INSERT INTO entries (id, version, record_sha256, kind, title, summary, body, scope, keywords, source_hashes, wikitrace_json, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deterministicId,
          recordSha256,
          req.kind,
          req.title.trim(),
          req.summary.trim(),
          req.body.trim(),
          scope,
          keywords,
          JSON.stringify(normalizedSourceHashes),
          JSON.stringify(wikitrace),
          nowSec,
        );
      this.db
        .prepare('INSERT INTO entries_fts (id, title, summary, body, keywords) VALUES (?, ?, ?, ?, ?)')
        .run(deterministicId, req.title.trim(), req.summary.trim(), req.body.trim(), keywords);
      this.db.exec('COMMIT');
      return { ok: true, status: 'inserted', id: deterministicId, version: 1, recordSha256 };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async feedback(id: string, helpful: boolean): Promise<{ ok: boolean; helpful: number; harmful: number }> {
    const col = helpful ? 'helpful' : 'harmful';
    this.db.prepare(`UPDATE entries SET ${col} = ${col} + 1 WHERE id = ? AND withdrawn = 0`).run(id);
    const row = this.db.prepare('SELECT helpful, harmful FROM entries WHERE id = ?').get(id) as
      | { helpful: number; harmful: number }
      | undefined;
    if (!row) return { ok: false, helpful: 0, harmful: 0 };
    return { ok: true, helpful: Number(row.helpful), harmful: Number(row.harmful) };
  }

  async stats(): Promise<{ entries: number; active: number; drifted: number; presentedCount: number }> {
    const rows = this.db.prepare('SELECT source_hashes, withdrawn FROM entries').all() as Array<{
      source_hashes: string;
      withdrawn: number;
    }>;
    let active = 0;
    let drifted = 0;
    const hashCache = new Map<string, string | null>();
    for (const r of rows) {
      if (Number(r.withdrawn ?? 0) === 0) {
        active += 1;
        const hashes = this.safeJsonParse<Record<string, string>>(r.source_hashes, {});
        if (Object.keys(hashes).length > 0 && detectDriftedFiles(this.workspaceRoot, hashes, hashCache).length > 0) drifted += 1;
      }
    }
    const seen = this.db.prepare('SELECT COUNT(*) AS n FROM session_seen').get() as { n: number };
    return { entries: rows.length, active, drifted, presentedCount: Number(seen?.n ?? 0) };
  }

  close(): void {
    this.db.close();
  }
}
