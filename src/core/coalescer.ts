/** Coalesces rapid tool and PTC dispatch events into frontier queries per agent step. */
export class ObservationCoalescer {
  private readonly observedFiles = new Set<string>();
  private pendingQueries: string[] = [];

  recordToolEvent(name: string, args: unknown, isError: boolean, outputPreview?: string): boolean {
    let signal = false;
    if (args && typeof args === 'object') {
      const rec = args as Record<string, unknown>;
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

  drainQuery(): string | null {
    if (this.pendingQueries.length === 0) return null;
    const joined = [...new Set(this.pendingQueries)].slice(0, 6).join(' ');
    this.pendingQueries = [];
    return joined;
  }
}
