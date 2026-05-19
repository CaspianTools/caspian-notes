import * as vscode from 'vscode';
import { NoteStore } from '../noteStore';
import { getActiveWorkspaceId, getCloudUid, isCloudSignedIn } from './auth';
import { pickWorkspaceProject } from './projectPicker';
import { getSyncHandle } from './sync';

// Bootstrap-style bulk upload. Triggered by the caspianNotes.uploadAll
// command (palette + status-bar quick-pick).
//
// Flow:
//   1. Confirm we're signed in + have an active workspace.
//   2. Quick-pick a default project to attribute every note to. The
//      picker has an explicit "(none)" option so users can keep notes
//      unattached.
//   3. NoteStore.markAllDirty(projectId) flips cloudDirty:true on every
//      active note and stamps projectId where missing.
//   4. Trigger an immediate outbound sweep via the sync engine handle
//      (otherwise we'd wait up to 15s for the next tick).

export async function uploadAllToCloud(
    context: vscode.ExtensionContext,
    store: NoteStore,
    output: vscode.OutputChannel | undefined,
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

    const notes = await store.list();
    if (notes.length === 0) {
        await vscode.window.showInformationMessage('No local notes to upload.');
        return;
    }

    const project = await pickWorkspaceProject(
        context,
        wsId,
        uid,
        `Default project for ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} (or none)`,
    );
    if (project === undefined) {
        // User dismissed the picker.
        return;
    }

    const confirm = await vscode.window.showInformationMessage(
        `Upload ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} to Caspian Tools?` +
            (project.id ? ` Attach to project: ${project.name}.` : ' Leave unattached.'),
        { modal: true },
        'Upload',
    );
    if (confirm !== 'Upload') { return; }

    const touched = await store.markAllDirty(project.id ?? null);
    output?.appendLine(`[cloud-sync] uploadAll: marked ${touched} notes dirty`);

    const handle = getSyncHandle();
    if (handle) {
        await handle.triggerOutbound();
    } else {
        await vscode.window.showWarningMessage(
            'Sync engine isn’t running yet. Notes will upload on the next tick after Connect.',
        );
        return;
    }

    await vscode.window.showInformationMessage(
        `Uploaded ${touched} ${touched === 1 ? 'note' : 'notes'} to Caspian Tools.`,
    );
}
