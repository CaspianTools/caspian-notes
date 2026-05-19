import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import matter from 'gray-matter';
import { Note } from './types';

export interface ParseError {
    file: string;
    reason: string;
}

const DELETED_SUBDIR = '.deleted';

export class NoteStore {
    private readonly changeListeners = new Set<() => void>();
    private readonly parseErrorListeners = new Set<(err: ParseError) => void>();
    // Process-lifetime UUIDv4 prefix used to tag every cloud write this
    // session emits. The sync engine uses it to skip echo loops via
    // writerTag.isOwnWrite(). Lazy so the prefix exists even if no cloud
    // pairing happens this session (commands that look it up are still
    // safe to call).
    private _sessionPrefix: string | null = null;

    static fromContext(context: vscode.ExtensionContext): NoteStore {
        return new NoteStore(path.join(context.globalStorageUri.fsPath, 'notes'));
    }

    constructor(public readonly dir: string) {}

    async init(): Promise<void> {
        // No-op: directory creation is deferred to the first write() so that
        // activation never blocks on filesystem I/O. Kept for backward compat.
    }

    onChange(listener: () => void): vscode.Disposable {
        this.changeListeners.add(listener);
        return { dispose: () => this.changeListeners.delete(listener) };
    }

    onParseError(listener: (err: ParseError) => void): vscode.Disposable {
        this.parseErrorListeners.add(listener);
        return { dispose: () => this.parseErrorListeners.delete(listener) };
    }

    private emitChange(): void {
        for (const l of this.changeListeners) {
            l();
        }
    }

    private emitParseError(err: ParseError): void {
        for (const l of this.parseErrorListeners) {
            l(err);
        }
    }

    /**
     * Active (non-deleted) notes only. Tombstones in .deleted/ are NOT
     * surfaced — they exist only to drive outbound sync of the delete and
     * to power Undo / cloud-restore.
     */
    async list(): Promise<Note[]> {
        const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
        const files = entries.filter((f) => f.endsWith('.md'));
        const results = await Promise.all(files.map((f) => this.read(path.join(this.dir, f))));
        const notes = results.filter((n): n is Note => n !== undefined && !n.deleted);
        notes.sort((a, b) => {
            if (a.pinned !== b.pinned) {
                return a.pinned ? -1 : 1;
            }
            return b.updatedAt.localeCompare(a.updatedAt);
        });
        return notes;
    }

    async get(id: string): Promise<Note | undefined> {
        // Active notes only. Tombstones live under .deleted/ and are
        // visible via getActiveOrTombstone() (cloud-sync use) or list-time
        // walks of the tombstone folder (getDirtyNotes). Keeping get()
        // active-only preserves back-compat with local-only UI callers
        // (tree provider, panel) that pre-date cloud sync.
        return this.read(this.pathFor(id));
    }

    private async getActiveOrTombstone(id: string): Promise<Note | undefined> {
        const active = await this.read(this.pathFor(id));
        if (active) { return active; }
        return this.read(this.tombstonePathFor(id));
    }

    async create(draft: { title: string; tags: string[]; body: string }): Promise<Note> {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const note: Note = {
            id,
            // Match localId === id so the on-disk filename stays stable and the
            // cloud doc id is deterministic from either side.
            localId: id,
            title: draft.title.trim() || 'Untitled',
            body: draft.body,
            tags: normaliseTags(draft.tags),
            createdAt: now,
            updatedAt: now,
            pinned: false,
            cloudDirty: true,
        };
        await this.write(note);
        this.emitChange();
        return note;
    }

    async update(
        id: string,
        patch: { title?: string; tags?: string[]; body?: string; pinned?: boolean; projectId?: string | null },
    ): Promise<Note | undefined> {
        const existing = await this.get(id);
        if (!existing) {
            return undefined;
        }
        // Cloud-sync v1: every edit (including pin toggle) bumps updatedAt
        // and re-arms cloudDirty. The earlier "pin doesn't bump updatedAt"
        // carve-out was removed because the cloud inbound poll keys on
        // `updatedAt > cursor` — a pin-only change wouldn't sync until the
        // next non-pin edit. Cost is small: the list still sorts pinned
        // ahead of unpinned, so the only visible difference is that within
        // the pinned block, a freshly-pinned note jumps to the top.
        const nextProjectId =
            patch.projectId === undefined
                ? existing.projectId
                : (patch.projectId === null ? undefined : patch.projectId);
        const next: Note = {
            ...existing,
            title: patch.title !== undefined ? (patch.title.trim() || 'Untitled') : existing.title,
            tags: patch.tags !== undefined ? normaliseTags(patch.tags) : existing.tags,
            body: patch.body !== undefined ? patch.body : existing.body,
            pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
            projectId: nextProjectId,
            updatedAt: new Date().toISOString(),
            cloudDirty: true,
        };
        await this.write(next);
        this.emitChange();
        return next;
    }

    /**
     * Soft-delete via tombstone: move the file to .deleted/<id>.md and stamp
     * deleted:true so the outbound sync tick pushes the delete to the cloud.
     * The local file still exists (and `get(id)` can find it), but `list()`
     * filters it out. Inbound applies cloud `deleted:true` by calling this.
     */
    async delete(id: string): Promise<void> {
        const existing = await this.getActiveOrTombstone(id);
        const now = new Date().toISOString();
        if (!existing) {
            await fs.unlink(this.pathFor(id)).catch(() => undefined);
            this.emitChange();
            return;
        }
        const next: Note = {
            ...existing,
            deleted: true,
            deletedAt: now,
            updatedAt: now,
            cloudDirty: true,
        };
        await this.writeTombstone(next);
        // Remove from the active folder if it's still there. .delete() the
        // active copy AFTER writing the tombstone so a crash in between
        // leaves the user with a recoverable tombstone, not a missing note.
        await fs.unlink(this.pathFor(id)).catch(() => undefined);
        this.emitChange();
    }

    /**
     * Re-write a previously-deleted note back to disk. Used by Undo after
     * delete and by the cloud sync's "remote restore" path (when the cloud
     * doc flips deleted: false → true after we've already tombstoned).
     * Preserves id, createdAt, updatedAt — does NOT bump updatedAt.
     */
    async restore(note: Note): Promise<void> {
        // Strip deleted flags on the in-memory copy before writing so the
        // restored file is clean.
        const clean: Note = { ...note };
        delete clean.deleted;
        delete clean.deletedAt;
        await this.write(clean);
        // Tombstone may exist alongside the active doc if we just restored
        // from cloud — clean it up so getDirtyNotes doesn't see both.
        await fs.unlink(this.tombstonePathFor(note.id)).catch(() => undefined);
        this.emitChange();
    }

    /**
     * Bulk-import notes from an external source (e.g. a JSON export from
     * another machine). Assigns fresh ids to every note to avoid
     * collisions, but preserves title/body/tags/pinned/createdAt where
     * present. Returns the number of notes successfully imported.
     */
    async importNotes(input: ReadonlyArray<unknown>): Promise<number> {
        const now = new Date().toISOString();
        let count = 0;
        for (const raw of input) {
            if (typeof raw !== 'object' || raw === null) {
                continue;
            }
            const r = raw as Partial<Note>;
            const id = crypto.randomUUID();
            const note: Note = {
                id,
                localId: id,
                title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : 'Untitled',
                body: typeof r.body === 'string' ? r.body : '',
                tags: Array.isArray(r.tags) ? normaliseTags(r.tags.map(String)) : [],
                pinned: r.pinned === true,
                createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
                updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
                cloudDirty: true,
            };
            await this.write(note);
            count++;
        }
        if (count > 0) {
            this.emitChange();
        }
        return count;
    }

    /**
     * Notify listeners that the underlying directory has changed (used by the
     * filesystem watcher in extension.ts).
     */
    notifyExternalChange(): void {
        this.emitChange();
    }

    // ── Cloud-sync helpers ────────────────────────────────────────────────
    //
    // Mirrors the IssueStore API the caspian-taskmaster sync engine consumes
    // (getSessionPrefix / getDirtyIssues / upsertFromCloud). The sync engine
    // calls these — nothing in the local-only UI does.

    getSessionPrefix(): string {
        if (!this._sessionPrefix) {
            this._sessionPrefix = crypto.randomUUID().slice(0, 8);
        }
        return this._sessionPrefix;
    }

    /**
     * Every note (active OR tombstone) with cloudDirty:true. Tombstones must
     * be included so the outbound loop pushes the delete; the engine then
     * clears the flag.
     */
    async getDirtyNotes(): Promise<Note[]> {
        const out: Note[] = [];
        const activeEntries = await fs.readdir(this.dir).catch(() => [] as string[]);
        for (const f of activeEntries) {
            if (!f.endsWith('.md')) { continue; }
            const n = await this.read(path.join(this.dir, f));
            if (n && n.cloudDirty) { out.push(n); }
        }
        const tombstoneDir = path.join(this.dir, DELETED_SUBDIR);
        const tombstoneEntries = await fs.readdir(tombstoneDir).catch(() => [] as string[]);
        for (const f of tombstoneEntries) {
            if (!f.endsWith('.md')) { continue; }
            const n = await this.read(path.join(tombstoneDir, f));
            if (n && n.cloudDirty) { out.push(n); }
        }
        return out;
    }

    /**
     * Clear cloudDirty + stamp syncedAt after a successful outbound push.
     * Doesn't fire onChange — sync metadata isn't a user-visible change.
     */
    async markCloudSynced(id: string, syncedAt: string, updatedBy: string): Promise<void> {
        const existing = await this.getActiveOrTombstone(id);
        if (!existing) { return; }
        const cleared: Note = {
            ...existing,
            cloudDirty: false,
            syncedAt,
            updatedBy,
        };
        if (existing.deleted) {
            await this.writeTombstone(cleared);
        } else {
            await this.write(cleared);
        }
    }

    /**
     * Apply a cloud-originated update to a local note WITHOUT re-marking it
     * dirty. The sync engine calls this for every inbound row that isn't
     * an echo of our own session. Three cases:
     *   • New: cloud has it, we don't → write to active folder.
     *   • Updated: cloud is newer than local → overwrite local.
     *   • Deleted: cloud has deleted:true → move local to tombstone (if
     *     active) and stamp the tombstone with the cloud's deletedAt.
     * Returns true if local state actually changed.
     */
    async upsertFromCloud(incoming: Partial<Note> & { id: string }): Promise<boolean> {
        const existing = await this.getActiveOrTombstone(incoming.id);
        const now = incoming.updatedAt ?? new Date().toISOString();

        // Cloud-side delete propagation
        if (incoming.deleted === true) {
            if (existing && !existing.deleted) {
                const next: Note = {
                    ...existing,
                    ...incoming,
                    deleted: true,
                    deletedAt: incoming.deletedAt ?? now,
                    cloudDirty: false,
                    syncedAt: now,
                };
                await this.writeTombstone(next);
                await fs.unlink(this.pathFor(incoming.id)).catch(() => undefined);
                this.emitChange();
                return true;
            }
            // Already tombstoned locally — just refresh the tombstone with
            // the cloud's syncedAt so the outbound loop doesn't redundantly
            // re-push.
            if (existing && existing.deleted) {
                const next: Note = {
                    ...existing,
                    ...incoming,
                    cloudDirty: false,
                    syncedAt: now,
                };
                await this.writeTombstone(next);
                return true;
            }
            return false;
        }

        // Cloud-side restore (cloud has deleted:false/absent, local is tombstoned)
        if (existing?.deleted) {
            const restored: Note = {
                id: incoming.id,
                localId: incoming.localId ?? existing.localId ?? incoming.id,
                workspaceId: incoming.workspaceId ?? existing.workspaceId,
                projectId: incoming.projectId ?? existing.projectId,
                title: incoming.title ?? existing.title,
                body: incoming.body ?? existing.body,
                tags: incoming.tags ?? existing.tags,
                pinned: incoming.pinned ?? existing.pinned,
                createdAt: incoming.createdAt ?? existing.createdAt,
                updatedAt: now,
                updatedBy: incoming.updatedBy,
                cloudDirty: false,
                syncedAt: now,
            };
            await this.restore(restored);
            return true;
        }

        if (existing) {
            if (existing.updatedAt && incoming.updatedAt
                && incoming.updatedAt <= existing.updatedAt
                && !existing.cloudDirty) {
                return false;
            }
            const next: Note = {
                ...existing,
                ...incoming,
                cloudDirty: false,
                syncedAt: now,
            };
            await this.write(next);
            this.emitChange();
            return true;
        }

        // Brand new from cloud.
        const seeded: Note = {
            id: incoming.id,
            localId: incoming.localId ?? incoming.id,
            workspaceId: incoming.workspaceId,
            projectId: incoming.projectId,
            title: incoming.title ?? 'Untitled',
            body: incoming.body ?? '',
            tags: incoming.tags ?? [],
            pinned: incoming.pinned === true,
            createdAt: incoming.createdAt ?? now,
            updatedAt: now,
            updatedBy: incoming.updatedBy,
            cloudDirty: false,
            syncedAt: now,
        };
        await this.write(seeded);
        this.emitChange();
        return true;
    }

    /**
     * Mark every active local note cloudDirty:true so the next outbound
     * tick pushes them. Used by the "Upload All to Caspian Tools" command.
     * Optionally stamps a default projectId on notes that don't already
     * have one. Returns how many notes were touched.
     */
    async markAllDirty(defaultProjectId: string | null): Promise<number> {
        const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
        let count = 0;
        for (const f of entries) {
            if (!f.endsWith('.md')) { continue; }
            const existing = await this.read(path.join(this.dir, f));
            if (!existing) { continue; }
            const next: Note = {
                ...existing,
                cloudDirty: true,
                projectId: existing.projectId ?? (defaultProjectId ?? undefined),
            };
            await this.write(next);
            count++;
        }
        if (count > 0) { this.emitChange(); }
        return count;
    }

    // ── Paths ─────────────────────────────────────────────────────────────

    private pathFor(id: string): string {
        return path.join(this.dir, `${id}.md`);
    }

    private tombstonePathFor(id: string): string {
        return path.join(this.dir, DELETED_SUBDIR, `${id}.md`);
    }

    private async read(filePath: string): Promise<Note | undefined> {
        const raw = await fs.readFile(filePath, 'utf8').catch(() => undefined);
        if (raw === undefined) {
            return undefined;
        }
        let parsed: matter.GrayMatterFile<string>;
        try {
            parsed = matter(raw);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.emitParseError({ file: filePath, reason });
            return undefined;
        }
        const data = parsed.data as Partial<Note>;
        const id = data.id ?? path.basename(filePath, '.md');
        // localId back-fill: legacy notes pre-cloud-sync had no localId in
        // frontmatter — use the file id stem. The next write() persists it.
        const localId = typeof data.localId === 'string' ? data.localId : id;
        const note: Note = {
            id,
            localId,
            workspaceId: typeof data.workspaceId === 'string' ? data.workspaceId : undefined,
            projectId: typeof data.projectId === 'string' ? data.projectId : undefined,
            title: typeof data.title === 'string' ? data.title : 'Untitled',
            tags: Array.isArray(data.tags) ? normaliseTags(data.tags.map(String)) : [],
            createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date(0).toISOString(),
            updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date(0).toISOString(),
            pinned: data.pinned === true,
            // Strip the leading blank line that write() inserts between the
            // frontmatter and body, and the single trailing newline that
            // gray-matter.stringify always appends. This keeps round-trip
            // (create → list → update → list) byte-stable.
            body: parsed.content.replace(/^\n+/, '').replace(/\n$/, ''),
            cloudDirty: data.cloudDirty === true ? true : undefined,
            syncedAt: typeof data.syncedAt === 'string' ? data.syncedAt : undefined,
            updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : undefined,
            deleted: data.deleted === true ? true : undefined,
            deletedAt: typeof data.deletedAt === 'string' ? data.deletedAt : undefined,
        };
        return note;
    }

    private async write(note: Note): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        const frontmatter = buildFrontmatter(note);
        const serialized = matter.stringify(`\n${note.body}`, frontmatter);
        await fs.writeFile(this.pathFor(note.id), serialized, 'utf8');
    }

    private async writeTombstone(note: Note): Promise<void> {
        const tombDir = path.join(this.dir, DELETED_SUBDIR);
        await fs.mkdir(tombDir, { recursive: true });
        const frontmatter = buildFrontmatter(note);
        const serialized = matter.stringify(`\n${note.body}`, frontmatter);
        await fs.writeFile(this.tombstonePathFor(note.id), serialized, 'utf8');
    }
}

function buildFrontmatter(note: Note): Record<string, unknown> {
    const fm: Record<string, unknown> = {
        id: note.id,
        title: note.title,
        tags: note.tags,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
    };
    if (note.localId) { fm.localId = note.localId; }
    if (note.pinned) { fm.pinned = true; }
    if (note.workspaceId) { fm.workspaceId = note.workspaceId; }
    if (note.projectId) { fm.projectId = note.projectId; }
    if (note.cloudDirty) { fm.cloudDirty = true; }
    if (note.syncedAt) { fm.syncedAt = note.syncedAt; }
    if (note.updatedBy) { fm.updatedBy = note.updatedBy; }
    if (note.deleted) { fm.deleted = true; }
    if (note.deletedAt) { fm.deletedAt = note.deletedAt; }
    return fm;
}

function normaliseTags(tags: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
        const t = raw.trim().toLowerCase();
        if (t && !seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    return out;
}

