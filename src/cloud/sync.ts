import * as vscode from 'vscode';
import { NoteStore } from '../noteStore';
import { Note } from '../types';
import { getCloudUid, isCloudSignedIn } from './auth';
import { getDoc, runQuery, setDoc } from './firestore';
import { isOwnWrite, tagWrite } from './writerTag';

// Bidirectional note-sync engine for caspiantools.com.
//
// Two coordinated loops, scoped to an AbortController so signOut() /
// extension deactivation tears them down cleanly:
//
//   • outbound (15s) — sweep local notes with cloudDirty:true (including
//     tombstones from .deleted/<id>.md), PATCH to Firestore, clear the
//     flag locally.
//   • inbound  (15s) — runQuery for notes updated since lastInboundCursor,
//     apply via store.upsertFromCloud (skipping our own session writes).
//
// Unlike caspian-taskmaster's parallel engine, there is NO GitHub push
// leg here — notes have no GitHub representation. cloudDirty:false after
// the Firestore PATCH is the terminal state.
//
// Started lazily once the user is signed in. Idle no-op when signed out.

const OUTBOUND_INTERVAL_MS = 15_000;
const INBOUND_INTERVAL_MS = 15_000;
const OUTBOUND_BATCH_LIMIT = 50;
const INBOUND_BATCH_LIMIT = 50;

const STATE_INBOUND_CURSOR_PREFIX = 'caspianNotes.cloud.inboundCursor.';

export interface SyncEngineHandle {
    stop(): void;
    isRunning(): boolean;
    triggerOutbound(): Promise<void>;
    status(): SyncStatus;
}

export interface SyncStatus {
    running: boolean;
    workspaceId: string | null;
    uid: string | null;
    lastInboundCursor: string | null;
    lastOutboundAt: string | null;
    lastInboundAt: string | null;
    pendingDirty: number;
    lastError: string | null;
}

interface InternalState extends SyncStatus {
    controller: AbortController;
    outboundTimer: NodeJS.Timeout | null;
    inboundTimer: NodeJS.Timeout | null;
}

let active: InternalState | null = null;
let handle: SyncEngineHandle | null = null;

/**
 * Start the sync engine. Idempotent: calling start() while running
 * returns the existing handle.
 */
export async function startSyncEngine(
    context: vscode.ExtensionContext,
    store: NoteStore,
    output: vscode.OutputChannel | undefined,
    workspaceId: string,
): Promise<SyncEngineHandle> {
    if (active && active.workspaceId === workspaceId) { return handle!; }
    if (active) { stopActive(); }

    const uid = await getCloudUid(context);
    if (!uid) { throw new Error('Sync engine cannot start: not signed in.'); }

    const sessionPrefix = store.getSessionPrefix();
    const cursorKey = STATE_INBOUND_CURSOR_PREFIX + workspaceId;
    const persistedCursor = context.globalState.get<string>(cursorKey) ?? null;

    const state: InternalState = {
        controller: new AbortController(),
        outboundTimer: null,
        inboundTimer: null,
        running: true,
        workspaceId,
        uid,
        lastInboundCursor: persistedCursor,
        lastOutboundAt: null,
        lastInboundAt: null,
        pendingDirty: 0,
        lastError: null,
    };
    active = state;

    output?.appendLine(`[cloud-sync] start uid=${uid} ws=${workspaceId} session=${sessionPrefix}`);

    void runOutbound(context, store, output, sessionPrefix);
    void runInbound(context, store, output, sessionPrefix, cursorKey);

    state.outboundTimer = setInterval(
        () => { void runOutbound(context, store, output, sessionPrefix); },
        OUTBOUND_INTERVAL_MS,
    );
    state.inboundTimer = setInterval(
        () => { void runInbound(context, store, output, sessionPrefix, cursorKey); },
        INBOUND_INTERVAL_MS,
    );

    handle = {
        stop: () => stopActive(output),
        isRunning: () => state.running,
        triggerOutbound: () => runOutbound(context, store, output, sessionPrefix),
        status: () => snapshot(state),
    };
    return handle;
}

function stopActive(output?: vscode.OutputChannel): void {
    if (!active) { return; }
    active.running = false;
    active.controller.abort();
    if (active.outboundTimer) { clearInterval(active.outboundTimer); }
    if (active.inboundTimer) { clearInterval(active.inboundTimer); }
    output?.appendLine('[cloud-sync] stopped');
    active = null;
    handle = null;
}

function snapshot(state: InternalState): SyncStatus {
    return {
        running: state.running,
        workspaceId: state.workspaceId,
        uid: state.uid,
        lastInboundCursor: state.lastInboundCursor,
        lastOutboundAt: state.lastOutboundAt,
        lastInboundAt: state.lastInboundAt,
        pendingDirty: state.pendingDirty,
        lastError: state.lastError,
    };
}

export function getSyncStatus(): SyncStatus | null {
    return active ? { ...active } : null;
}

export function isSyncRunning(): boolean {
    return !!active && active.running;
}

export function stopSyncEngine(output?: vscode.OutputChannel): void {
    stopActive(output);
}

export function getSyncHandle(): SyncEngineHandle | null {
    return handle;
}

// ── Loops ────────────────────────────────────────────────────────────────

async function runOutbound(
    context: vscode.ExtensionContext,
    store: NoteStore,
    output: vscode.OutputChannel | undefined,
    sessionPrefix: string,
): Promise<void> {
    if (!active || !active.running) { return; }
    if (!(await isCloudSignedIn(context))) { return; }
    const wsId = active.workspaceId;
    const uid = active.uid;
    if (!wsId || !uid) { return; }

    const dirty = (await store.getDirtyNotes()).slice(0, OUTBOUND_BATCH_LIMIT);
    active.pendingDirty = dirty.length;
    if (dirty.length === 0) {
        active.lastOutboundAt = new Date().toISOString();
        return;
    }

    // Authoritative workspace membership, refreshed once per outbound sweep.
    // Only used to seed `memberUids` on a FIRST push — see buildNotePayload.
    const memberUids = await fetchWorkspaceMembers(context, wsId, uid, output);

    for (const note of dirty) {
        if (!active || !active.running) { return; }
        try {
            const localId = note.localId ?? note.id;
            const docId = `${wsId}_${localId}`;
            const payload = buildNotePayload(note, wsId, uid, localId, memberUids);
            const tagged = tagWrite(payload, { uid, sessionPrefix });
            await setDoc(context, `notes/${docId}`, tagged);
            await store.markCloudSynced(note.id, tagged.updatedAt, tagged.updatedBy);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            active.lastError = `outbound ${note.id}: ${msg}`;
            output?.appendLine(`[cloud-sync] outbound ${note.id} failed: ${msg}`);
            // Don't tear down on a single failure; sweeper retries next tick.
            break;
        }
    }
    active.lastOutboundAt = new Date().toISOString();
    active.pendingDirty = (await store.getDirtyNotes()).length;
}

async function runInbound(
    context: vscode.ExtensionContext,
    store: NoteStore,
    output: vscode.OutputChannel | undefined,
    sessionPrefix: string,
    cursorKey: string,
): Promise<void> {
    if (!active || !active.running) { return; }
    if (!(await isCloudSignedIn(context))) { return; }
    const wsId = active.workspaceId;
    const uid = active.uid;
    if (!wsId || !uid) { return; }

    const cursor = active.lastInboundCursor ?? '1970-01-01T00:00:00.000Z';
    try {
        const rows = await runQuery(context, '', {
            from: [{ collectionId: 'notes' }],
            where: {
                compositeFilter: {
                    op: 'AND',
                    filters: [
                        {
                            fieldFilter: {
                                field: { fieldPath: 'workspaceId' },
                                op: 'EQUAL',
                                value: { stringValue: wsId },
                            },
                        },
                        {
                            fieldFilter: {
                                field: { fieldPath: 'memberUids' },
                                op: 'ARRAY_CONTAINS',
                                value: { stringValue: uid },
                            },
                        },
                        {
                            fieldFilter: {
                                field: { fieldPath: 'updatedAt' },
                                op: 'GREATER_THAN',
                                value: { stringValue: cursor },
                            },
                        },
                    ],
                },
            },
            orderBy: [
                { field: { fieldPath: 'updatedAt' }, direction: 'ASCENDING' },
            ],
            limit: INBOUND_BATCH_LIMIT,
        });

        let newestSeen = cursor;
        for (const row of rows) {
            if (!active || !active.running) { return; }
            const data = row.data as Partial<Note> & { id?: string };
            // Skip our own-session echoes (the writer-tag rule).
            if (isOwnWrite(data.updatedBy as string | undefined, { uid, sessionPrefix })) {
                if (typeof data.updatedAt === 'string' && data.updatedAt > newestSeen) {
                    newestSeen = data.updatedAt;
                }
                continue;
            }
            // Local store keys by `localId` (== file basename). Use the
            // doc's `localId` field if present, else strip the workspace
            // prefix from the doc id.
            const cloudLocalId = (data as { localId?: unknown }).localId;
            const localId = typeof cloudLocalId === 'string'
                ? cloudLocalId
                : row.id.replace(`${wsId}_`, '');
            await store.upsertFromCloud({ ...data, id: localId });
            if (typeof data.updatedAt === 'string' && data.updatedAt > newestSeen) {
                newestSeen = data.updatedAt;
            }
        }

        if (newestSeen !== cursor) {
            active.lastInboundCursor = newestSeen;
            await context.globalState.update(cursorKey, newestSeen);
        }
        active.lastInboundAt = new Date().toISOString();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        active.lastError = `inbound: ${msg}`;
        output?.appendLine(`[cloud-sync] inbound failed: ${msg}`);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * The workspace's real member list, for seeding `memberUids` on a first push.
 *
 * `memberUids` is the tenancy anchor: the web's per-document read rule checks it
 * and every live query filters on `array-contains uid`. Seeding it with just
 * `[uid]` — which this extension used to do — creates a note that is invisible
 * to every colleague in the workspace, permanently. The comment here used to
 * claim `onWorkspaceMemberChange` would fan the value out; it does not. That
 * trigger fires on a workspace-document UPDATE, so it only re-mirrors when
 * membership actually CHANGES — a note created wrong in a stable workspace
 * stays wrong forever. Reading the workspace document costs one GET per sweep.
 *
 * Falls back to `[uid]` when the read fails, since that is still enough to
 * satisfy the create rule and the server now normalises the value anyway.
 */
async function fetchWorkspaceMembers(
    context: vscode.ExtensionContext,
    wsId: string,
    uid: string,
    output: vscode.OutputChannel | undefined,
): Promise<string[]> {
    try {
        const ws = await getDoc(context, `workspaces/${wsId}`);
        const members = ws?.memberUids;
        if (Array.isArray(members) && members.length > 0) {
            return members.filter((m): m is string => typeof m === 'string');
        }
    } catch (err) {
        output?.appendLine(
            `[cloud-sync] could not read workspace members: ${err instanceof Error ? err.message : err}`,
        );
    }
    return [uid];
}

function buildNotePayload(
    note: Note,
    wsId: string,
    uid: string,
    localId: string,
    memberUids: string[],
): Record<string, unknown> {
    // Shape mirrors the web's Note schema (caspiantools/lib/notes/types.ts).
    // No GitHub fields, no localDirty/githubDirty — those are Tasks-specific.
    const docId = `${wsId}_${localId}`;
    const payload: Record<string, unknown> = {
        id: docId,
        localId,
        workspaceId: wsId,
        // Always the Firebase uid — `firestore.rules` for /notes requires
        // `ownerUid == request.auth.uid` on create.
        ownerUid: uid,
        title: note.title,
        body: note.body,
        tags: note.tags,
        pinned: note.pinned === true,
        createdBy: uid,
        createdAt: note.createdAt,
        cloudDirty: false,
    };
    // `memberUids` is sent ONLY on a first push, and never on an update.
    //
    // The web's create rule requires `request.auth.uid in memberUids`, so a
    // create cannot omit it. But the update rule pins it (`tenancyUnchanged()`),
    // and setDoc's updateMask covers every key in this payload — so including it
    // on an update sends a value the server compares against its own and rejects
    // with PERMISSION_DENIED the moment the two differ. That is exactly what
    // happened to every note in a workspace with two or more members.
    //
    // `syncedAt` is stamped only after a successful push (or an inbound apply),
    // so its absence is exactly "this document does not exist in the cloud yet".
    if (!note.syncedAt) { payload.memberUids = memberUids; }
    if (note.projectId) { payload.projectId = note.projectId; }
    if (note.deleted === true) {
        payload.deleted = true;
        if (note.deletedAt) { payload.deletedAt = note.deletedAt; }
    }
    return payload;
}

