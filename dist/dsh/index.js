import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ForewispBridge, ObservationCoalescer, validateKnowledgeWrite, } from '../core/index.js';
export const name = 'ns-context';
export const inject = ['tools', 'agents', 'systemPrompt'];
export const Config = z.object({
    mode: z.union([z.const('auto'), z.const('local'), z.const('daemon')]).default('auto'),
    daemonUrl: z.string(),
    inlineBytes: z.number().default(1800),
    maxOffers: z.number().default(3),
    turn1TimeoutMs: z.number().default(50),
});
function renderJsonText(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}
function extractLatestUserText(messages) {
    const userMsgs = messages.filter((m) => !m.role || m.role === 'user');
    const latest = userMsgs.at(-1);
    if (!latest || !Array.isArray(latest.content))
        return '';
    return latest.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
}
export function apply(ctx, rawConfig = {}) {
    const config = {
        mode: rawConfig.mode ?? 'auto',
        daemonUrl: rawConfig.daemonUrl ?? process.env.FOREWISP_URL,
        inlineBytes: rawConfig.inlineBytes ?? 1800,
        maxOffers: rawConfig.maxOffers ?? 3,
        turn1TimeoutMs: rawConfig.turn1TimeoutMs ?? 50,
    };
    let disposed = false;
    const bridgeCache = new Map();
    const getBridge = (workspaceRoot) => {
        if (disposed)
            throw new Error('ns-context plugin is disposed');
        const key = workspaceRoot || process.cwd();
        let bridge = bridgeCache.get(key);
        if (!bridge) {
            bridge = new ForewispBridge({
                workspaceRoot: key,
                mode: config.mode,
                daemonUrl: config.daemonUrl,
                inlineBytes: config.inlineBytes,
                maxOffers: config.maxOffers,
                turn1TimeoutMs: config.turn1TimeoutMs,
            });
            bridgeCache.set(key, bridge);
        }
        return bridge;
    };
    const defaultBridge = getBridge(process.cwd());
    ctx.provide('nsContext', defaultBridge);
    const states = new Map();
    const stateFor = (agent) => {
        const id = String(agent.session.id);
        let st = states.get(id);
        if (!st) {
            st = {
                agent,
                conversationId: id,
                coalescer: new ObservationCoalescer(),
                activeOffers: [],
                renderedKeys: [],
                deferredWrites: [],
                lastTurnError: false,
                initialRetrieved: false,
            };
            states.set(id, st);
        }
        return st;
    };
    const agentRoot = (agent) => {
        const meta = agent?.session?.meta;
        return typeof meta?.cwd === 'string' && meta.cwd.length > 0 ? meta.cwd : process.cwd();
    };
    // Single auto-superseded runtime-context slot: tracks exact rendered offer keys for llm/stream ack.
    ctx.systemPrompt.context({
        name: 'ns-context:forewisp',
        order: 180,
        interpolate: false,
        text: (assembleCtx) => {
            const agent = assembleCtx.agent;
            if (!agent)
                return '';
            const st = states.get(String(agent.session.id));
            if (!st || st.activeOffers.length === 0) {
                if (st)
                    st.renderedKeys = [];
                return '';
            }
            st.renderedKeys = st.activeOffers.map((o) => `${o.id}:${o.version}`);
            const lines = st.activeOffers.map((o) => {
                const header = `[${o.id}@v${o.version} | ${o.kind}/${o.scope} | ${o.title}]`;
                return `${header}\n${o.inlineBody ?? o.summary}`;
            });
            return `<forewisp-context count="${st.activeOffers.length}">\n${lines.join('\n\n')}\n</forewisp-context>`;
        },
    });
    // Bounded Turn-1 retrieval BEFORE Step 1 prompt refresh & dispatch (fail-open).
    ctx.on('agent/pre-step', async (payload, next) => {
        const st = stateFor(payload.agent);
        st.lastTurnError = false;
        try {
            const bridge = getBridge(agentRoot(payload.agent));
            const userPrompt = extractLatestUserText(payload.messages);
            const coalesced = st.coalescer.drainQuery();
            const query = [userPrompt, coalesced].filter(Boolean).join(' ').trim();
            if (query && (!st.initialRetrieved || coalesced)) {
                const timeoutMs = st.initialRetrieved ? config.turn1TimeoutMs : Math.max(config.turn1TimeoutMs, 150);
                const res = await bridge.retrieve(query, st.conversationId, { timeoutMs });
                st.initialRetrieved = true;
                st.activeOffers = res.offers;
            }
            else if (!st.initialRetrieved) {
                st.activeOffers = [];
            }
        }
        catch {
            st.activeOffers = [];
        }
        return next();
    });
    // Acknowledge only offers actually rendered into the step's runtime context.
    ctx.on('llm/stream', async function* (options, next) {
        const rawSessionId = options.sessionId;
        if (rawSessionId !== undefined) {
            const st = states.get(String(rawSessionId));
            if (st && st.renderedKeys.length > 0) {
                try {
                    getBridge(agentRoot(st.agent)).markPresented(st.conversationId, st.renderedKeys);
                    st.renderedKeys = [];
                }
                catch { /* non-fatal telemetry receipt */ }
            }
        }
        for await (const chunk of next())
            yield chunk;
    });
    ctx.on('tools/result', (exec, result) => {
        if (!exec.agent || exec.name.startsWith('forewisp_'))
            return;
        const st = stateFor(exec.agent);
        const preview = (Array.isArray(result?.content) ? result.content : [])
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join(' ')
            .slice(0, 200);
        st.coalescer.recordToolEvent(exec.name, exec.arguments, result?.isError === true, preview);
    });
    ctx.on('session/event', (payload) => {
        const ev = payload;
        const sid = ev.session?.id ? String(ev.session.id) : undefined;
        if (!sid || ev.type !== 'tool/ptc-dispatch')
            return;
        const st = states.get(sid);
        if (!st)
            return;
        const toolName = String(ev.data?.tool ?? 'ptc');
        if (toolName.startsWith('forewisp_'))
            return;
        st.coalescer.recordToolEvent(toolName, ev.data?.args, Boolean(ev.data?.isError), String(ev.data?.summary ?? ''));
    });
    const log = ctx.logger('ns-context');
    ctx.on('agent/error', ({ agent }) => {
        const st = states.get(String(agent.session.id));
        if (st) {
            st.lastTurnError = true;
            if (st.deferredWrites.length > 0) {
                log.warn(`discarded ${st.deferredWrites.length} deferred upsert(s) after agent/error`);
            }
            st.deferredWrites = [];
        }
    });
    const flushDeferred = async (agent) => {
        const st = states.get(String(agent.session.id));
        if (!st || st.lastTurnError || st.deferredWrites.length === 0)
            return 0;
        const bridge = getBridge(agentRoot(agent));
        const pending = st.deferredWrites.splice(0, st.deferredWrites.length);
        let committed = 0;
        for (const req of pending) {
            try {
                const out = await bridge.upsert(req);
                if (out.ok)
                    committed += 1;
            }
            catch {
                // Isolate single-entry persistence failures so remaining writes and turn teardown settle cleanly.
            }
        }
        return committed;
    };
    ctx.on('agent/turn-stopping', async ({ agent }) => {
        await flushDeferred(agent);
    });
    if (ctx.get('subagents')) {
        ctx.on('subagent/end', async (info) => {
            const child = ctx.agents.get(info.id);
            if (!child)
                return;
            if (info.stopReason === 'completed') {
                await flushDeferred(child);
            }
            else {
                const st = states.get(String(child.session.id));
                if (st) {
                    if (st.deferredWrites.length > 0) {
                        log.warn(`discarded ${st.deferredWrites.length} deferred upsert(s) after subagent stop=${info.stopReason}`);
                    }
                    st.deferredWrites = [];
                }
            }
        });
    }
    ctx.on('agent/disposed', ({ agent }) => {
        states.delete(String(agent.session.id));
    });
    const schemaObj = { type: 'object', properties: {}, additionalProperties: true };
    ctx.tools.register(defineTool({
        name: 'forewisp_search',
        description: 'Search Forewisp workspace memory and guidance cards with WikiTrace applicability filtering.',
        parameters: {
            query: { type: 'string', required: true, description: 'Search query (symbol, file, error, or concept).' },
        },
        output: { schema: schemaObj, render: renderJsonText },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const bridge = getBridge(agentRoot(exec.agent));
            const res = await bridge.retrieve(args.query, exec.agent ? String(exec.agent.session.id) : 'manual');
            return {
                tier: res.tier,
                latencyMs: res.latencyMs,
                offers: res.offers.map((o) => ({
                    id: o.id,
                    version: o.version,
                    recordSha256: o.recordSha256,
                    kind: o.kind,
                    title: o.title,
                    summary: o.summary,
                    driftedFiles: o.driftedFiles,
                    expandBytes: o.expandBytes,
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'forewisp_expand',
        description: 'Expand a Forewisp context card body (enforces SHA-256 live file-drift check unless allowStale=true).',
        parameters: {
            id: { type: 'string', required: true, description: 'Forewisp entry ID.' },
            allowStale: { type: 'boolean', description: 'Set true only after checking referenced files manually.' },
            offset: { type: 'integer', description: 'Byte offset for paged expansion.' },
            limit: { type: 'integer', description: 'Byte limit (default 8192, max 32768).' },
        },
        output: { schema: schemaObj, render: renderJsonText },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const bridge = getBridge(agentRoot(exec.agent));
            return bridge.expand(args.id, {
                allowStale: args.allowStale,
                offset: args.offset,
                limit: args.limit,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'forewisp_upsert',
        description: 'Validate and upsert a verified fact, guidance, or skill into Forewisp (enforces secret, drift, and CAS gates).',
        parameters: {
            id: { type: 'string', description: 'Existing entry ID for revision update; omit for deterministic ID.' },
            kind: { type: 'string', required: true, enum: ['memory', 'guidance', 'skill', 'library'] },
            title: { type: 'string', required: true, description: 'Short descriptive title (<=160B).' },
            summary: { type: 'string', required: true, description: 'One-line takeaway (<=200B).' },
            body: { type: 'string', required: true, description: 'Verified factual guidance (<=64KiB, zero secrets).' },
            keywords: { type: 'string', description: 'Space-separated code identifiers.' },
            sourcePaths: { type: 'array', items: { type: 'string' }, description: 'Relative workspace file paths to SHA-256 pin.' },
            baseRevision: { type: 'integer', description: 'Expected current revision for optimistic CAS updates.' },
            baseRecordSha256: { type: 'string', description: 'Expected current SHA-256 for optimistic CAS updates.' },
            deferred: { type: 'boolean', description: 'Queue write until current turn completes cleanly.' },
        },
        output: { schema: schemaObj, render: renderJsonText },
        execute: async (args, exec) => {
            const root = agentRoot(exec.agent);
            const req = {
                schema: 'forewisp.knowledge.v1',
                ...(args.id ? { id: args.id } : {}),
                kind: args.kind,
                title: args.title,
                summary: args.summary,
                body: args.body,
                ...(args.keywords ? { keywords: args.keywords } : {}),
                ...(args.sourcePaths ? { sourcePaths: args.sourcePaths } : {}),
                ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
                ...(args.baseRecordSha256 ? { baseRecordSha256: args.baseRecordSha256 } : {}),
            };
            if (args.deferred && exec.agent) {
                const check = validateKnowledgeWrite(req, root);
                if (check.issues.length > 0) {
                    return { ok: false, status: 'rejected', reason: check.issues[0].message, issues: check.issues };
                }
                const st = stateFor(exec.agent);
                if (st.deferredWrites.length >= 16) {
                    return { ok: false, status: 'rejected', reason: 'deferred queue cap (16) reached' };
                }
                st.deferredWrites.push(req);
                return { ok: true, status: 'queued', pending: st.deferredWrites.length };
            }
            return getBridge(root).upsert(req);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'forewisp_feedback',
        description: 'Record helpful/harmful outcome signal on a delivered Forewisp card.',
        parameters: {
            id: { type: 'string', required: true, description: 'Forewisp entry ID.' },
            helpful: { type: 'boolean', required: true, description: 'True if card prevented thrash or improved outcome.' },
        },
        output: { schema: schemaObj, render: renderJsonText },
        execute: async (args, exec) => getBridge(agentRoot(exec.agent)).feedback(args.id, args.helpful),
    }));
    const registerSlash = (commandsSvc) => {
        commandsSvc.register({
            name: 'wisp',
            description: 'Show Forewisp context store stats or run a search (/wisp <query>).',
            handler: async ({ agent, rawInput }) => {
                try {
                    const bridge = getBridge(agentRoot(agent));
                    const q = rawInput.trim();
                    if (!q || q === 'stats') {
                        const st = await bridge.stats();
                        return {
                            kind: 'success',
                            text: `Forewisp (${bridge.mode}): ${st.active} active / ${st.entries} total (${st.drifted} drifted, ${st.presentedCount} delivered).`,
                        };
                    }
                    const sid = agent?.session?.id ? String(agent.session.id) : 'slash';
                    const res = await bridge.retrieve(q, sid);
                    if (res.offers.length === 0)
                        return { kind: 'success', text: `Forewisp (${res.latencyMs}ms): no matching entries.` };
                    return {
                        kind: 'success',
                        text: res.offers.map((o) => `• ${o.id} [v${o.version}, score=${o.score}]: ${o.title} — ${o.summary}`).join('\n'),
                    };
                }
                catch (err) {
                    return { kind: 'error', text: err instanceof Error ? err.message : String(err) };
                }
            },
        });
    };
    if (ctx.get('commands'))
        registerSlash(ctx.get('commands'));
    else
        ctx.inject(['commands'], (subCtx) => registerSlash(subCtx.commands));
    ctx.effect(() => () => {
        disposed = true;
        for (const bridge of bridgeCache.values())
            bridge.close();
        bridgeCache.clear();
    });
}
//# sourceMappingURL=index.js.map