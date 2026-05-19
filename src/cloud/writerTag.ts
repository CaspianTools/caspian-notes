// Single chokepoint for the EXTENSION-SYNC-CONTRACT writer-tag rule.
// Every cloud write the extension performs must stamp `updatedBy` with
// `extension:<uid>:<sessionPrefix>`. The web's onNoteWrite trigger
// short-circuits on this prefix so extension writes don't fan out
// duplicate notifications, and the inbound sync loop skips docs whose
// tag matches their own session (prevents echo loops).
//
// Centralising here means a future entity type can't silently forget
// to stamp. Verbatim copy of the equivalent file in caspian-taskmaster.

export interface WriterTagInputs {
    uid: string;
    sessionPrefix: string;
}

/** Build the writer-tag string for a cloud write. */
export function buildWriterTag({ uid, sessionPrefix }: WriterTagInputs): string {
    return `extension:${uid}:${sessionPrefix}`;
}

/**
 * Wrap a cloud-write payload with the writer-tag and a fresh `updatedAt`.
 * The shape is permissive — any field not in the payload stays untouched.
 */
export function tagWrite<T extends Record<string, unknown>>(
    data: T,
    inputs: WriterTagInputs,
): T & { updatedBy: string; updatedAt: string } {
    return {
        ...data,
        updatedBy: buildWriterTag(inputs),
        updatedAt: new Date().toISOString(),
    };
}

/**
 * True if `updatedBy` was written by THIS session — i.e. the extension's
 * own write echoing back via the inbound listener. Used to skip own-write
 * round-trips. Other extension instances on different machines (different
 * sessionPrefix) deliberately fall through and are processed normally.
 */
export function isOwnWrite(
    updatedBy: string | undefined | null,
    inputs: WriterTagInputs,
): boolean {
    if (!updatedBy) { return false; }
    return updatedBy === buildWriterTag(inputs);
}
