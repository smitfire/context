/** Coalesces rapid tool and PTC dispatch events into frontier queries per agent step. */
export declare class ObservationCoalescer {
    private readonly observedFiles;
    private pendingQueries;
    recordToolEvent(name: string, args: unknown, isError: boolean, outputPreview?: string): boolean;
    drainQuery(): string | null;
}
//# sourceMappingURL=coalescer.d.ts.map