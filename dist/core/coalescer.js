/** Coalesces rapid tool and PTC dispatch events into frontier queries per agent step. */
export class ObservationCoalescer {
    observedFiles = new Set();
    pendingQueries = [];
    recordToolEvent(name, args, isError, outputPreview) {
        let signal = false;
        if (args && typeof args === 'object') {
            const rec = args;
            for (const field of ['path', 'file_path', 'target', 'query', 'pattern']) {
                const val = rec[field];
                if (typeof val === 'string' && val.trim() && !this.observedFiles.has(val.trim())) {
                    this.observedFiles.add(val.trim());
                    this.pendingQueries.push(val.trim());
                    signal = true;
                }
            }
        }
        if (isError && outputPreview) {
            this.pendingQueries.push(`${name} error: ${outputPreview.slice(0, 160)}`);
            signal = true;
        }
        return signal;
    }
    drainQuery() {
        if (this.pendingQueries.length === 0)
            return null;
        const joined = [...new Set(this.pendingQueries)].slice(0, 6).join(' ');
        this.pendingQueries = [];
        return joined;
    }
}
//# sourceMappingURL=coalescer.js.map