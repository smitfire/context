import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ContextEntryRecord,
  KnowledgeWriteRequest,
  ValidationIssue,
  WikiTraceApplicability,
  WorkspaceDependencies,
} from './types.js';

export const KNOWLEDGE_SCHEMA_ID = 'forewisp.knowledge.v1';
export const MAX_TITLE_BYTES = 160;
export const MAX_SUMMARY_BYTES = 200;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_KEYWORDS_BYTES = 1024;

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  'owner',
  'organization',
  'scope_key',
  'scopeKey',
  'source',
  'origin',
  'automated',
  'helpful',
  'harmful',
  'withdrawn',
]);

const ALLOWED_REQUEST_FIELDS = new Set([
  'schema',
  'id',
  'kind',
  'scope',
  'title',
  'summary',
  'body',
  'keywords',
  'sourceHashes',
  'sourcePaths',
  'wikitrace',
  'baseRevision',
  'baseRecordSha256',
]);

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /-----BEGIN\s+(?:RSA|EC|OPENSSH|PGP|PRIVATE)\s+KEY-----/,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@[^\s/]+/i,
];

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?\b/i,
  /\bsystem\s+prompt\s+override\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?developer\s+mode\b/i,
];

const SEMVER_REQ_RE = /^(?:\*|(?:[\^~]|[<>]=?|=)?\d+(?:\.\d+)?(?:\.\d+)?(?:\s+(?:[\^~]|[<>]=?|=)?\d+(?:\.\d+)?(?:\.\d+)?)*)$/;
const ALLOWED_SCOPES = new Set(['agent', 'user', 'repository', 'organization', 'public']);
const ENTRY_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function looksLikePromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export function computeRecordSha256(fields: {
  kind: string;
  scope: string;
  title: string;
  summary: string;
  body: string;
  keywords: string;
  sourceHashes: Record<string, string>;
  wikitrace: WikiTraceApplicability;
}): string {
  const canonical = JSON.stringify({
    kind: fields.kind,
    scope: fields.scope,
    title: fields.title,
    summary: fields.summary,
    body: fields.body,
    keywords: fields.keywords,
    sourceHashes: Object.fromEntries(Object.entries(fields.sourceHashes).sort(([a], [b]) => a.localeCompare(b))),
    wikitrace: fields.wikitrace,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function hashWorkspaceFile(workspaceRoot: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath)) return null;
  const root = resolve(workspaceRoot);
  const full = resolve(root, relPath);
  const rel = relative(root, full);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  if (!existsSync(full)) return null;
  const st = lstatSync(full);
  if (st.isSymbolicLink() || !st.isFile() || st.size > 2 * 1024 * 1024) return null;
  return createHash('sha256').update(readFileSync(full)).digest('hex');
}

export function detectDriftedFiles(
  workspaceRoot: string,
  sourceHashes: Record<string, string>,
  cache?: Map<string, string | null>,
): string[] {
  const drifted: string[] = [];
  for (const [relPath, expected] of Object.entries(sourceHashes)) {
    let current = cache?.get(relPath);
    if (current === undefined) {
      current = hashWorkspaceFile(workspaceRoot, relPath);
      cache?.set(relPath, current);
    }
    if (current === null || current !== expected) drifted.push(relPath);
  }
  return drifted;
}

export function inspectWorkspaceDependencies(workspaceRoot: string): WorkspaceDependencies {
  const ecosystems = new Set<'node' | 'python' | 'rust'>();
  const packages = new Map<string, string>();
  const imports = new Set<string>();
  const root = resolve(workspaceRoot);

  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    ecosystems.add('node');
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
      for (const bucket of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const rec = parsed[bucket];
        if (rec && typeof rec === 'object') {
          for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
            if (typeof v === 'string') packages.set(k.toLowerCase(), v);
          }
        }
      }
    } catch { /* ignore invalid json */ }
  }

  const cargoPath = join(root, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    ecosystems.add('rust');
    const cargo = readFileSync(cargoPath, 'utf8');
    for (const m of cargo.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/gm)) {
      packages.set(m[1].toLowerCase(), m[2]);
    }
  }

  const pyPath = join(root, 'pyproject.toml');
  if (existsSync(pyPath)) {
    ecosystems.add('python');
    const py = readFileSync(pyPath, 'utf8');
    for (const m of py.matchAll(/"([A-Za-z0-9_.-]+)(?:[<>=!~][^"]*)?"/g)) {
      packages.set(m[1].toLowerCase(), '*');
    }
  }

  // Shallow source-import scan (bounded to keep Turn-1 fast).
  const stack: string[] = [root];
  let filesScanned = 0;
  while (stack.length > 0 && filesScanned < 60) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|py|rs)$/.test(entry.name)) {
        filesScanned += 1;
        try {
          const text = readFileSync(full, 'utf8').slice(0, 8192);
          for (const m of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]|^\s*(?:import|from)\s+([A-Za-z0-9_]+)/gm)) {
            const raw = (m[1] ?? m[2] ?? '').trim();
            if (!raw || raw.startsWith('.')) continue;
            const rootPkg = raw.startsWith('@') ? raw.split('/').slice(0, 2).join('/') : raw.split('/')[0];
            imports.add(rootPkg.toLowerCase());
          }
        } catch { /* ignore unreadable file */ }
        if (filesScanned >= 60) break;
      }
    }
  }

  return { ecosystems, packages, imports };
}

function parseSemverTuple(ver: string): [number, number, number] | null {
  const m = ver.trim().replace(/^[~^=v]/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function satisfiesSimpleReq(actualRaw: string, reqRaw: string): boolean {
  const req = reqRaw.trim();
  if (!req || req === '*') return true;
  const actual = parseSemverTuple(actualRaw);
  if (!actual) return true;
  for (const part of req.split(/\s+/)) {
    const target = parseSemverTuple(part.replace(/^[<>]=?|[~^=]/, ''));
    if (!target) continue;
    const cmp = actual[0] !== target[0] ? actual[0] - target[0] : actual[1] !== target[1] ? actual[1] - target[1] : actual[2] - target[2];
    if (part.startsWith('>=')) { if (cmp < 0) return false; }
    else if (part.startsWith('<=')) { if (cmp > 0) return false; }
    else if (part.startsWith('>')) { if (cmp <= 0) return false; }
    else if (part.startsWith('<')) { if (cmp >= 0) return false; }
    else if (part.startsWith('^')) { if (actual[0] !== target[0] || cmp < 0) return false; }
    else if (part.startsWith('~')) { if (actual[0] !== target[0] || actual[1] !== target[1] || cmp < 0) return false; }
    else if (cmp !== 0) return false;
  }
  return true;
}

export function isWikiTraceCompatible(entry: ContextEntryRecord, deps: WorkspaceDependencies): boolean {
  const wt = entry.wikitrace ?? {};
  if (wt.ecosystem && wt.ecosystem !== 'polyglot' && deps.ecosystems.size > 0 && !deps.ecosystems.has(wt.ecosystem)) {
    return false;
  }
  if (wt.forbiddenImports) {
    for (const pkg of wt.forbiddenImports) {
      const k = pkg.toLowerCase();
      if (deps.packages.has(k) || deps.imports.has(k)) return false;
    }
  }
  if (wt.packages) {
    for (const [pkg, req] of Object.entries(wt.packages)) {
      const k = pkg.toLowerCase();
      const presentVer = deps.packages.get(k);
      const imported = deps.imports.has(k);
      // Zero-Import Distractor Guard: framework-pinned memory blocked if workspace neither declares nor imports it.
      if (presentVer === undefined && !imported) return false;
      if (presentVer !== undefined && !satisfiesSimpleReq(presentVer, req)) return false;
    }
  }
  return true;
}

export function validateKnowledgeWrite(
  req: KnowledgeWriteRequest,
  workspaceRoot: string,
): { issues: ValidationIssue[]; normalizedSourceHashes: Record<string, string> } {
  const issues: ValidationIssue[] = [];
  if (req.schema !== undefined && req.schema !== KNOWLEDGE_SCHEMA_ID) {
    issues.push({ code: 'SCHEMA_INVALID', message: `schema must equal ${KNOWLEDGE_SCHEMA_ID}` });
  }
  for (const key of Object.keys(req)) {
    if (FORBIDDEN_AUTHORITY_FIELDS.has(key)) {
      issues.push({ code: 'AUTHORITY_FIELD_REJECTED', message: `model cannot set authority field "${key}"` });
    } else if (!ALLOWED_REQUEST_FIELDS.has(key)) {
      issues.push({ code: 'SCHEMA_INVALID', message: `unknown field "${key}"` });
    }
  }
  if (!['memory', 'guidance', 'skill', 'library'].includes(req.kind)) {
    issues.push({ code: 'SCHEMA_INVALID', message: `invalid kind "${String(req.kind)}"` });
  }
  if (req.scope !== undefined && !ALLOWED_SCOPES.has(String(req.scope))) {
    issues.push({ code: 'SCHEMA_INVALID', message: `invalid scope "${String(req.scope)}"` });
  }
  if (req.id !== undefined && (typeof req.id !== 'string' || !ENTRY_ID_RE.test(req.id.trim()))) {
    issues.push({ code: 'SCHEMA_INVALID', message: 'id must match ^[A-Za-z0-9_.:-]{1,128}$' });
  }
  if (!req.title?.trim() || !req.summary?.trim() || !req.body?.trim()) {
    issues.push({ code: 'SCHEMA_INVALID', message: 'title, summary, and body must be non-empty' });
  }
  const bLen = (s: string) => Buffer.byteLength(s ?? '', 'utf8');
  if (bLen(req.title) > MAX_TITLE_BYTES) {
    issues.push({ code: 'BYTE_LIMIT_EXCEEDED', message: `title exceeds ${MAX_TITLE_BYTES} bytes` });
  }
  if (bLen(req.summary) > MAX_SUMMARY_BYTES) {
    issues.push({ code: 'BYTE_LIMIT_EXCEEDED', message: `summary exceeds ${MAX_SUMMARY_BYTES} bytes` });
  }
  if (bLen(req.body) > MAX_BODY_BYTES) {
    issues.push({ code: 'BYTE_LIMIT_EXCEEDED', message: `body exceeds ${MAX_BODY_BYTES} bytes` });
  }
  if (req.keywords && bLen(req.keywords) > MAX_KEYWORDS_BYTES) {
    issues.push({ code: 'BYTE_LIMIT_EXCEEDED', message: `keywords exceeds ${MAX_KEYWORDS_BYTES} bytes` });
  }
  const combinedText = `${req.title}\n${req.summary}\n${req.body}\n${req.keywords ?? ''}`;
  if (containsSecrets(combinedText)) {
    issues.push({ code: 'SECRET_DETECTED', message: 'rejected knowledge containing credential or private-key material' });
  }
  if (looksLikePromptInjection(combinedText)) {
    issues.push({ code: 'PROMPT_INJECTION_DETECTED', message: 'rejected knowledge containing prompt-injection directives' });
  }
  if (req.wikitrace?.packages) {
    for (const [pkg, range] of Object.entries(req.wikitrace.packages)) {
      if (!pkg.trim() || !SEMVER_REQ_RE.test(range.trim())) {
        issues.push({ code: 'SEMVER_INVALID', message: `invalid semver requirement for "${pkg}": ${range}` });
      }
    }
  }
  const normalizedSourceHashes: Record<string, string> = {};
  if (req.sourceHashes) {
    for (const [relPath, expectedHash] of Object.entries(req.sourceHashes)) {
      const liveHash = hashWorkspaceFile(workspaceRoot, relPath);
      if (liveHash === null) {
        issues.push({ code: 'SOURCE_PATH_INVALID', message: `referenced source file missing or outside workspace: ${relPath}` });
      } else if (liveHash !== expectedHash) {
        issues.push({ code: 'SOURCE_DRIFTED', message: `source file "${relPath}" changed before upsert commit` });
      } else {
        normalizedSourceHashes[relPath] = liveHash;
      }
    }
  }
  if (req.sourcePaths) {
    for (const relPath of req.sourcePaths) {
      const liveHash = hashWorkspaceFile(workspaceRoot, relPath);
      if (liveHash === null) {
        issues.push({ code: 'SOURCE_PATH_INVALID', message: `sourcePath missing or outside workspace: ${relPath}` });
      } else {
        normalizedSourceHashes[relPath] = liveHash;
      }
    }
  }
  return { issues, normalizedSourceHashes };
}
