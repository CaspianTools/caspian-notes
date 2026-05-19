// Stable per-note identifier used to build the cloud doc id
// (`${workspaceId}_${localId}`). Bit-identical algorithm to caspiantools'
// lib/utils.ts:makeLocalId — keeping them in sync means the web and the
// extension agree on doc-id format, and pre-cloud notes whose `id` was
// already a UUID can be back-filled via `localId = id` without colliding
// with any post-cloud localId.

export function makeLocalId(): string {
    return `mod${Math.floor(1000 + Math.random() * 9000)}`;
}
