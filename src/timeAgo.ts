// Minimal relative-time helper for tree-item descriptions + tooltips.
// Kept tiny on purpose — no Intl.RelativeTimeFormat (the format isn't
// localized anywhere else in this extension) and no full date fallback
// dependency.

export function formatRelativeShort(iso: string | undefined): string {
    if (!iso) { return ''; }
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) { return ''; }
    const diffMs = Date.now() - then;
    if (diffMs < 0) { return 'just now'; }
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diffMs < min) { return 'just now'; }
    if (diffMs < hour) { return `${Math.floor(diffMs / min)}m ago`; }
    if (diffMs < day) { return `${Math.floor(diffMs / hour)}h ago`; }
    if (diffMs < 30 * day) { return `${Math.floor(diffMs / day)}d ago`; }
    return new Date(iso).toISOString().slice(0, 10);
}
