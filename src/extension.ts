import * as vscode from 'vscode';
import * as path from 'path';
import { NoteStore } from './noteStore';
import { NotePanel } from './notePanel';
import { NoteTreeItem, NoteTreeProvider } from './noteTreeProvider';
import { ActionPresenter, performAction } from './noteActions';
import { CardAction } from './types';
import {
    connectCloud,
    getActiveWorkspaceId,
    isCloudSignedIn,
    signOutCloud,
} from './cloud/auth';
import { notifyPairingCallback } from './cloud/pair';
import {
    getSyncHandle,
    getSyncStatus,
    isSyncRunning,
    startSyncEngine,
    stopSyncEngine,
} from './cloud/sync';
import { uploadAllToCloud } from './cloud/uploadAll';
import { assignProjectCommand } from './cloud/assignProject';

export function activate(context: vscode.ExtensionContext): void {
    // Defensive activation: register every command BEFORE any cloud-related
    // setup, so a throw inside the cloud machinery doesn't leave the
    // extension half-activated with the welcome panel's links resolving to
    // "command not found" (the symptom we hit in v1.4.0).
    //
    // The cloud-specific UI (status bar, URI handler, auto-start sync engine)
    // is wrapped in isolated try/catch blocks AFTER the command-registration
    // block. If any of them fails, the user can still hit `Caspian Notes:
    // Connect` from the command palette and pair manually; the status bar
    // just won't reflect the state until the next reload.

    const cloudOutput = vscode.window.createOutputChannel('Caspian Notes');
    context.subscriptions.push(cloudOutput);
    cloudOutput.appendLine('[caspian-notes] activate: entry');
    // eslint-disable-next-line no-console
    console.log('[caspian-notes] activate: entry');

    const store = NoteStore.fromContext(context);
    const tree = new NoteTreeProvider(store);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('caspianNotesList', tree));

    // Refresh the tree when the grouping setting changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('caspianNotes.treeGrouping')) {
                tree.refresh();
            }
        }),
    );

    // Surface parse errors once per file, with a "Reveal in Folder" action.
    const warnedFiles = new Set<string>();
    context.subscriptions.push(
        store.onParseError(({ file, reason }) => {
            if (warnedFiles.has(file)) {
                return;
            }
            warnedFiles.add(file);
            const name = path.basename(file);
            vscode.window
                .showWarningMessage(
                    `Caspian Notes: couldn't parse "${name}" — ${reason}`,
                    'Reveal in Folder',
                )
                .then((choice) => {
                    if (choice === 'Reveal in Folder') {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
                    }
                });
        }),
    );

    // Watch the storage dir so external edits (sync, manual edit, restore
    // from backup) refresh the UI without requiring a reload.
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(store.dir), '*.md'),
    );
    const refresh = () => store.notifyExternalChange();
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate(refresh),
        watcher.onDidChange(refresh),
        watcher.onDidDelete(refresh),
    );

    // Status-bar / notification presenter for tree-command-driven actions.
    const hostPresenter: ActionPresenter = {
        notify(message, level) {
            if (level === 'error') {
                vscode.window.showWarningMessage(message);
            } else {
                vscode.window.setStatusBarMessage(message, 2000);
            }
        },
        onEdit(noteId) {
            NotePanel.createOrShow(context, store, { editId: noteId });
        },
    };
    const dispatch = (action: CardAction, id: string | undefined) =>
        performAction(store, action, id, hostPresenter);

    // `refreshStatus` is reassigned later when the status bar item is
    // created. The cloud commands close over this binding via `let`, so
    // they call a noop until then — never throw because of a missing fn.
    let refreshStatus: () => void = () => undefined;

    function setSignedInContext(v: boolean): void {
        void vscode.commands.executeCommand('setContext', 'caspianNotes.cloud.signedIn', v);
    }
    // Default to false so viewsWelcome / view-title menus render the
    // "Connect" affordances on first activation. The auto-start IIFE
    // overwrites this once it has probed the secret store.
    setSignedInContext(false);

    // ── Command registration (must happen first) ──────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('caspianNotes.open', () => {
            NotePanel.createOrShow(context, store);
        }),
        vscode.commands.registerCommand('caspianNotes.new', () => {
            NotePanel.createOrShow(context, store, 'new');
        }),
        vscode.commands.registerCommand('caspianNotes.refresh', () => tree.refresh()),
        vscode.commands.registerCommand('caspianNotes.toggleTreeGrouping', async () => {
            const cfg = vscode.workspace.getConfiguration('caspianNotes');
            const current = cfg.get<string>('treeGrouping', 'flat');
            const next = current === 'byTag' ? 'flat' : 'byTag';
            await cfg.update('treeGrouping', next, vscode.ConfigurationTarget.Global);
        }),
        vscode.commands.registerCommand('caspianNotes.insertFromPicker', () => insertFromPicker(store)),
        vscode.commands.registerCommand('caspianNotes.item.defaultAction', (arg: unknown) =>
            dispatch(defaultCardAction(), asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.item.copy', (arg: unknown) =>
            dispatch('copy', asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.item.insert', (arg: unknown) =>
            dispatch('insert', asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.item.edit', (arg: unknown) =>
            dispatch('edit', asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.item.sendToChat', (arg: unknown) =>
            dispatch('sendToChat', asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.item.delete', (arg: unknown) =>
            deleteItem(store, asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.item.duplicate', (arg: unknown) =>
            duplicateItem(store, asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.item.togglePin', (arg: unknown) =>
            togglePin(store, asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.exportLibrary', () => exportLibrary(store)),
        vscode.commands.registerCommand('caspianNotes.importLibrary', () => importLibrary(store)),

        // ── Cloud commands ────────────────────────────────────────────────
        vscode.commands.registerCommand('caspianNotes.connect', async () => {
            try {
                const identity = await connectCloud(context);
                await startSyncEngine(context, store, cloudOutput, identity.workspaceId);
                setSignedInContext(true);
                refreshStatus();
                const wsLabel = identity.workspaceName ?? identity.workspaceId;
                await vscode.window.showInformationMessage(
                    `Connected Caspian Notes to ${wsLabel}.`,
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg !== 'Connect cancelled.') {
                    await vscode.window.showErrorMessage(`Caspian Notes connect failed: ${msg}`);
                }
            }
        }),
        vscode.commands.registerCommand('caspianNotes.disconnect', async () => {
            stopSyncEngine(cloudOutput);
            await signOutCloud(context);
            setSignedInContext(false);
            refreshStatus();
            await vscode.window.showInformationMessage('Disconnected from Caspian Tools.');
        }),
        vscode.commands.registerCommand('caspianNotes.uploadAll', () =>
            uploadAllToCloud(context, store, cloudOutput),
        ),
        vscode.commands.registerCommand('caspianNotes.syncNow', async () => {
            const handle = getSyncHandle();
            if (!handle) {
                await vscode.window.showWarningMessage(
                    'Sync engine isn’t running. Connect first (Caspian Notes: Connect).',
                );
                return;
            }
            await handle.triggerOutbound();
            refreshStatus();
        }),
        vscode.commands.registerCommand('caspianNotes.assignProject', (arg: unknown) =>
            assignProjectCommand(context, store, cloudOutput, asId(arg)),
        ),
        vscode.commands.registerCommand('caspianNotes.cloudStatus', async () => {
            const items: vscode.QuickPickItem[] = [];
            const running = isSyncRunning();
            if (running) {
                items.push({ label: '$(sync) Sync now', description: 'Push pending notes immediately' });
                items.push({ label: '$(cloud-upload) Upload all notes', description: 'One-time bulk upload' });
                items.push({ label: '$(folder) Assign a note to a project', description: 'Pick from your local notes' });
                items.push({ label: '$(circle-slash) Disconnect', description: 'Sign out of Caspian Tools' });
            } else {
                items.push({ label: '$(cloud) Connect to Caspian Tools', description: 'Pair this extension with caspiantools.com' });
            }
            const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Caspian Notes cloud sync' });
            if (!pick) { return; }
            if (pick.label.includes('Sync now')) {
                await vscode.commands.executeCommand('caspianNotes.syncNow');
            } else if (pick.label.includes('Upload all')) {
                await vscode.commands.executeCommand('caspianNotes.uploadAll');
            } else if (pick.label.includes('Assign a note')) {
                await vscode.commands.executeCommand('caspianNotes.assignProject');
            } else if (pick.label.includes('Disconnect')) {
                await vscode.commands.executeCommand('caspianNotes.disconnect');
            } else if (pick.label.includes('Connect')) {
                await vscode.commands.executeCommand('caspianNotes.connect');
            }
        }),
    );
    cloudOutput.appendLine('[caspian-notes] activate: commands registered');

    // ── Cloud setup (isolated; failures are logged, never thrown) ─────────

    try {
        const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
        status.command = 'caspianNotes.cloudStatus';
        context.subscriptions.push(status);
        refreshStatus = () => {
            const s = getSyncStatus();
            if (!s) {
                status.text = '$(circle-slash) Notes offline';
                status.tooltip = 'Notes are local-only. Click to connect.';
            } else if (s.pendingDirty > 0) {
                status.text = `$(cloud-upload) Notes ${s.pendingDirty} pending`;
                status.tooltip = `${s.pendingDirty} notes waiting to sync to Caspian Tools`;
            } else {
                status.text = '$(cloud) Notes synced';
                status.tooltip = 'Notes synced with Caspian Tools';
            }
            status.show();
        };
        refreshStatus();
        const statusTimer = setInterval(refreshStatus, 5_000);
        context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });
        cloudOutput.appendLine('[caspian-notes] activate: status bar ok');
    } catch (err) {
        cloudOutput.appendLine(`[caspian-notes] activate: status bar FAILED — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        // eslint-disable-next-line no-console
        console.error('[caspian-notes] status bar failed:', err);
    }

    try {
        // URI handler for the device-pairing callback. The web page dispatches
        //   vscode://CaspianTools.caspian-notes/pair?session=...&status=ok
        // after the user picks a workspace; we forward the session id to
        // pair.ts which is awaiting it.
        context.subscriptions.push(
            vscode.window.registerUriHandler({
                handleUri(uri) {
                    if (uri.path === '/pair') {
                        const sessionId = new URLSearchParams(uri.query).get('session');
                        if (sessionId) {
                            notifyPairingCallback(sessionId);
                        }
                    }
                },
            }),
        );
        cloudOutput.appendLine('[caspian-notes] activate: URI handler ok');
    } catch (err) {
        cloudOutput.appendLine(`[caspian-notes] activate: URI handler FAILED — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        // eslint-disable-next-line no-console
        console.error('[caspian-notes] URI handler failed:', err);
    }

    // Auto-start the sync engine if we're already signed in (the user paired
    // in a previous session). Fire-and-forget — don't block activation on
    // the identity probe.
    void (async () => {
        try {
            const signedIn = await isCloudSignedIn(context);
            setSignedInContext(signedIn);
            if (signedIn) {
                const wsId = getActiveWorkspaceId(context);
                if (wsId) {
                    await startSyncEngine(context, store, cloudOutput, wsId);
                    refreshStatus();
                    cloudOutput.appendLine(`[caspian-notes] activate: auto-started sync for ws=${wsId}`);
                } else {
                    cloudOutput.appendLine('[caspian-notes] activate: signed in but no workspaceId stored');
                }
            } else {
                cloudOutput.appendLine('[caspian-notes] activate: not signed in (no auto-start)');
            }
        } catch (err) {
            cloudOutput.appendLine(`[caspian-notes] activate: auto-start FAILED — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            // eslint-disable-next-line no-console
            console.error('[caspian-notes] auto-start failed:', err);
        }
    })();

    cloudOutput.appendLine('[caspian-notes] activate: done');
}

async function exportLibrary(store: NoteStore): Promise<void> {
    const notes = await store.list();
    if (notes.length === 0) {
        vscode.window.showInformationMessage('Caspian Notes: nothing to export — your library is empty.');
        return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`caspian-notes-${today}.json`),
        filters: { JSON: ['json'] },
        title: 'Export Caspian Notes Library',
    });
    if (!uri) {
        return;
    }
    const payload = {
        format: 'caspian-notes/v1',
        exportedAt: new Date().toISOString(),
        notes,
    };
    await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
    );
    vscode.window.showInformationMessage(
        `Exported ${notes.length} note${notes.length === 1 ? '' : 's'} to ${path.basename(uri.fsPath)}.`,
    );
}

async function importLibrary(store: NoteStore): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
        title: 'Import Caspian Notes Library',
    });
    if (!uris || uris.length === 0) {
        return;
    }
    const fileUri = uris[0]!;
    const data = await vscode.workspace.fs.readFile(fileUri);
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
        vscode.window.showErrorMessage('Caspian Notes: import failed — file is not valid JSON.');
        return;
    }
    let notesArray: unknown[] | null = null;
    if (parsed && typeof parsed === 'object') {
        const maybe = (parsed as { notes?: unknown }).notes;
        if (Array.isArray(maybe)) {
            notesArray = maybe;
        } else if (Array.isArray(parsed)) {
            // Tolerate a bare-array form too.
            notesArray = parsed;
        }
    } else if (Array.isArray(parsed)) {
        notesArray = parsed;
    }
    if (!notesArray) {
        vscode.window.showErrorMessage(
            'Caspian Notes: import failed — expected a `notes` array or a top-level array of notes.',
        );
        return;
    }
    const count = await store.importNotes(notesArray);
    vscode.window.showInformationMessage(
        `Imported ${count} note${count === 1 ? '' : 's'}. Existing notes were not modified; imported entries got fresh IDs.`,
    );
}

export function deactivate(): void {
    // subscriptions are disposed via context.subscriptions
}

function defaultCardAction(): CardAction {
    const raw = vscode.workspace.getConfiguration('caspianNotes').get<string>('defaultCardAction') ?? 'copy';
    if (raw === 'insert' || raw === 'edit' || raw === 'copy') {
        return raw;
    }
    return 'copy';
}

function asId(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg instanceof NoteTreeItem) {
        return arg.note.id;
    }
    return undefined;
}

async function togglePin(store: NoteStore, id: string | undefined): Promise<void> {
    if (!id) {
        return;
    }
    const note = await store.get(id);
    if (!note) {
        return;
    }
    await store.update(id, { pinned: !note.pinned });
}

async function duplicateItem(store: NoteStore, id: string | undefined): Promise<void> {
    if (!id) {
        return;
    }
    const source = await store.get(id);
    if (!source) {
        return;
    }
    const newTitle = source.title === 'Untitled' ? 'Untitled' : `${source.title} (copy)`;
    await store.create({
        title: newTitle,
        tags: source.tags,
        body: source.body,
    });
}

async function deleteItem(store: NoteStore, id: string | undefined): Promise<void> {
    if (!id) {
        return;
    }
    const note = await store.get(id);
    if (!note) {
        return;
    }
    await store.delete(id);
    const choice = await vscode.window.showInformationMessage(
        `Deleted "${note.title}"`,
        'Undo',
    );
    if (choice === 'Undo') {
        await store.restore(note);
    }
}

async function insertFromPicker(store: NoteStore): Promise<void> {
    const notes = await store.list();
    if (notes.length === 0) {
        vscode.window.showInformationMessage('No notes yet. Open the Notes Library to add one.');
        return;
    }
    const pick = await vscode.window.showQuickPick(
        notes.map((n) => ({
            label: n.title,
            description: n.tags.join(', '),
            detail: n.body.slice(0, 120).replace(/\s+/g, ' '),
            id: n.id,
        })),
        { placeHolder: 'Pick a note to insert at the cursor' },
    );
    if (!pick) {
        return;
    }
    // Reuse the action dispatch via the registered command — keeps the
    // insert-with-no-active-editor fallback consistent.
    await vscode.commands.executeCommand('caspianNotes.item.insert', pick.id);
}
