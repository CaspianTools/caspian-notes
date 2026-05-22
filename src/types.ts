export interface Note {
    id: string;
    title: string;
    body: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    pinned: boolean;

    // ── Cloud-sync fields (all optional; absent on legacy local-only notes)
    // and on notes created before the first cloud pairing). See
    // c:\Users\fuadj\GitHub\caspiantools\docs\EXTENSION-SYNC-CONTRACT.md §10.
    //
    // localId is the stable identifier the cloud doc id is built from:
    // `${workspaceId}_${localId}`. For legacy notes whose only id is the
    // file's UUID stem, NoteStore.read() back-fills localId = id on read.
    // For notes created post-cloud-sync, localId is generated up front via
    // makeLocalId() and matches `id` so the on-disk filename stays stable.
    localId?: string;
    workspaceId?: string;
    projectId?: string;
    // Per-doc queue marker for outbound sync. Set true by every mutating
    // path (create/update/delete/pin-toggle/project-assign), cleared by the
    // outbound sync tick after Firestore PATCH succeeds.
    cloudDirty?: boolean;
    syncedAt?: string;
    // Set when an inbound apply detects the cloud-side updatedAt is older
    // than the local updatedAt — there's a divergence that can't be
    // resolved without user input. Surfaced by the tree-item ⚠ marker.
    // (Not currently written by any code path; reserved for a future
    // three-way conflict detector. Reading it is safe.)
    hasConflict?: boolean;
    // Writer-tag set by the cloud sync engine — `extension:<uid>:<sessionPrefix>`.
    // Inbound sync uses isOwnWrite() to skip docs that echo this session's
    // own writes. Local-only edits don't write this field.
    updatedBy?: string;
    // Soft-delete tombstone. Local delete moves the file to .deleted/<id>.md
    // and stamps these two; outbound pushes deleted:true to the cloud doc,
    // and inbound applies cloud deletes by moving the local file too.
    deleted?: boolean;
    deletedAt?: string;
}

export type CardAction = 'copy' | 'insert' | 'edit' | 'sendToChat';

export type HostToWebview =
    | { type: 'init'; notes: Note[]; defaultAction: CardAction; minColumnWidth: number }
    | { type: 'updated'; notes: Note[] }
    | { type: 'toast'; message: string; level?: 'info' | 'error' }
    | { type: 'focusNew' }
    | { type: 'focusEdit'; id: string };

export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'action'; action: CardAction; id: string }
    | { type: 'create'; draft: { title: string; tags: string[]; body: string } }
    | { type: 'update'; id: string; patch: { title?: string; tags?: string[]; body?: string; pinned?: boolean } }
    | { type: 'delete'; id: string };
