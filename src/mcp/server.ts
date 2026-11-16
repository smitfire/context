#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ForewispBridge, type KnowledgeWriteRequest } from '../core/index.js';

const TOOLS = [
  {
    name: 'forewisp_search',
    description: 'Search Forewisp workspace memory and guidance cards with WikiTrace filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        conversationId: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'forewisp_expand',
    description: 'Expand a Forewisp context card body with SHA-256 live file-drift check.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        allowStale: { type: 'boolean' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['id'],
    },
  },
  {
    name: 'forewisp_upsert',
    description: 'Validate and upsert knowledge into Forewisp (secret, drift, and CAS revision gates).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['memory', 'guidance', 'skill', 'library'] },
        title: { type: 'string' },
        summary: { type: 'string' },
        body: { type: 'string' },
        keywords: { type: 'string' },
        sourcePaths: { type: 'array', items: { type: 'string' } },
        baseRevision: { type: 'integer' },
        baseRecordSha256: { type: 'string' },
      },
      required: ['kind', 'title', 'summary', 'body'],
    },
  },
  {
    name: 'forewisp_feedback',
    description: 'Record helpful/harmful signal on a Forewisp entry.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        helpful: { type: 'boolean' },
      },
      required: ['id', 'helpful'],
    },
  },
];

async function readBoundedStdin(maxBytes = 128 * 1024, timeoutMs = 1500): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    process.stdin.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (total + buf.length >= maxBytes) {
        chunks.push(buf.subarray(0, Math.max(0, maxBytes - total)));
        process.stdin.destroy();
        finish();
        return;
      }
      chunks.push(buf);
      total += buf.length;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

export async function runPreInvocationHook(workspaceRoot: string, stdinText?: string): Promise<string> {
  const raw = (stdinText ?? (await readBoundedStdin())).slice(0, 65_536);
  let prompt = '';
  let conversationId = `hook-${process.pid}`;
  try {
    const payload = JSON.parse(raw) as { prompt?: string; userPrompt?: string; conversation_id?: string };
    prompt = typeof payload.prompt === 'string' ? payload.prompt : typeof payload.userPrompt === 'string' ? payload.userPrompt : '';
    if (typeof payload.conversation_id === 'string' && payload.conversation_id) {
      conversationId = payload.conversation_id;
    }
  } catch {
    prompt = raw.trim().slice(0, 4096);
  }
  if (!prompt) return JSON.stringify({});

  let bridge: ForewispBridge | undefined;
  try {
    bridge = new ForewispBridge({ workspaceRoot, mode: 'auto' });
    const res = await bridge.retrieve(prompt, conversationId);
    if (res.offers.length === 0) return JSON.stringify({});
    bridge.markPresented(conversationId, res.offers.map((o) => `${o.id}:${o.version}`));
    const contextText = res.offers.map((o) => `[${o.id}] ${o.title}: ${o.inlineBody ?? o.summary}`).join('\n\n');
    return JSON.stringify({ additionalContext: `<forewisp-context>\n${contextText}\n</forewisp-context>` });
  } catch {
    return JSON.stringify({});
  } finally {
    bridge?.close();
  }
}

class RpcParamError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export async function startMcpServer(workspaceRoot = process.cwd()): Promise<void> {
  const bridge = new ForewispBridge({ workspaceRoot, mode: 'auto' });
  const defaultConv = `mcp-${process.pid}`;
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.id === undefined || req.method === undefined) continue;
    try {
      if (req.method === 'initialize') {
        write({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'ns-context', version: '0.1.0' },
          },
        });
      } else if (req.method === 'tools/list') {
        write({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
      } else if (req.method === 'tools/call') {
        const name = String(req.params?.name ?? '');
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new RpcParamError(-32602, 'arguments must be an object');
        }
        let payload: unknown;
        if (name === 'forewisp_search') {
          if (typeof args.query !== 'string' || !args.query.trim()) throw new RpcParamError(-32602, 'query must be a non-empty string');
          payload = await bridge.retrieve(args.query, typeof args.conversationId === 'string' ? args.conversationId : defaultConv);
        } else if (name === 'forewisp_expand') {
          if (typeof args.id !== 'string' || !args.id.trim()) throw new RpcParamError(-32602, 'id must be a non-empty string');
          payload = await bridge.expand(args.id, {
            allowStale: Boolean(args.allowStale),
            offset: typeof args.offset === 'number' ? args.offset : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
        } else if (name === 'forewisp_upsert') {
          if (
            typeof args.kind !== 'string' ||
            typeof args.title !== 'string' ||
            typeof args.summary !== 'string' ||
            typeof args.body !== 'string'
          ) {
            throw new RpcParamError(-32602, 'forewisp_upsert requires string kind, title, summary, and body');
          }
          payload = await bridge.upsert({ ...(args as unknown as KnowledgeWriteRequest), schema: 'forewisp.knowledge.v1' });
        } else if (name === 'forewisp_feedback') {
          if (typeof args.id !== 'string' || typeof args.helpful !== 'boolean') {
            throw new RpcParamError(-32602, 'forewisp_feedback requires string id and boolean helpful');
          }
          payload = await bridge.feedback(args.id, args.helpful);
        } else {
          throw new RpcParamError(-32601, `unknown tool: ${name}`);
        }
        const isError =
          typeof payload === 'object' &&
          payload !== null &&
          ((payload as { ok?: unknown }).ok === false);
        write({
          jsonrpc: '2.0',
          id: req.id,
          result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] },
        });
      } else {
        throw new RpcParamError(-32601, `method not found: ${req.method}`);
      }
    } catch (error) {
      const code = error instanceof RpcParamError ? error.code : -32000;
      write({
        jsonrpc: '2.0',
        id: req.id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  bridge.close();
}

const isEntrypoint = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  if (process.argv[2] === 'pre-invocation') {
    const out = await runPreInvocationHook(process.argv[3] ?? process.cwd());
    process.stdout.write(`${out}\n`);
  } else {
    await startMcpServer(process.argv[2] ?? process.cwd());
  }
}
