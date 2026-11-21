import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ContextMode, type NsContextService } from '../core/index.js';
export declare const name = "ns-context";
export declare const inject: readonly ["tools", "agents", "systemPrompt"];
export interface PluginConfig {
    mode: ContextMode;
    daemonUrl?: string;
    dbPath?: string;
    inlineBytes: number;
    maxOffers: number;
    turn1TimeoutMs: number;
    daemonTimeoutMs?: number;
}
export declare const Config: z<PluginConfig>;
declare module '@deepseek-ai/cordis' {
    interface Context {
        nsContext?: NsContextService;
    }
}
export declare function apply(ctx: Context, rawConfig?: Partial<PluginConfig>): void;
//# sourceMappingURL=index.d.ts.map