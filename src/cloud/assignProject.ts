import * as vscode from 'vscode';
import { NoteStore } from '../noteStore';
import { getActiveWorkspaceId, getCloudUid, isCloudSignedIn } from './auth';
import { pickWorkspaceProject } from './projectPicker';
import { getSyncHandle } from './sync';

// Per-note "Assign to project" command. Targeted by both the command
// palette (caspianNotes.assignProject) and the tree-view item context
// menu. Resolves the active note via the passed-in `id`, or — when
// invoked from the palette without a target — opens a quick-pick over
// the local note list.

export async function assignProjectCommand(
    context: vscode.ExtensionContext,
    store: NoteStore,
    output: vscode.OutputChannel | undefined,
    targetId?: string,
): Promise<void> {
    if (!(await isCloudSignedIn(context))) {
        await vscode.window.showWarningMessage(
            'Connect to Caspian Tools first (Caspian Notes: Connect).',
        );
        return;
    }
    const wsId = getActiveWorkspaceId(context);
    const uid = await getCloudUid(context);
    if (!wsId || !uid) {
        await vscode.window.showWarningMessage(
            'No paired workspace. Run Caspian Notes: Connect again.',
        );
        return;
    }

    let id = targetId;
    if (!id) {
        const notes = await store.list();
        if (notes.length === 0) {
            await vscode.window.showInformationMessage('No notes to assign.');
            return;
        }
        const pick = await vscode.window.showQuickPick(
            notes.map((n) => ({
                label: n.title || 'Untitled',
                description: n.projectId ? `currently: ${n.projectId}` : '(no project)',
                detail: n.id,
            })),
            { placeHolder: 'Pick a note to assign to a project' },
        );
        if (!pick) { return; }
        id = pick.detail;
    }

    const note = await store.get(id);
    if (!note) {
        await vscode.window.showWarningMessage('That note no longer exists.');
        return;
    }

    const project = await pickWorkspaceProject(
        context,
        wsId,
        uid,
        `Project for "${note.title || 'Untitled'}" (or none)`,
    );
    if (project === undefined) { return; }

    await store.update(id, { projectId: project.id });
    output?.appendLine(`[cloud-sync] assignProject ${id} → ${project.id ?? '(none)'}`);

    // Don't wait for the 15s tick — push immediately so the web sees it.
    const handle = getSyncHandle();
    if (handle) {
        await handle.triggerOutbound();
    }
}
