import * as vscode from 'vscode';
import { runQuery } from './firestore';

// Shared workspace-project picker used by both the "Upload all" bootstrap
// and the per-note "Assign to project" command.
//
// Queries /projects filtered by `workspaceId == active AND
// memberUids array-contains uid`, which is exactly the index the web
// uses for useWorkspaceProjects. Returns the picked project id, or null
// for the explicit "(none)" option, or undefined if the user dismissed
// the picker.

export interface PickedProject {
    id: string | null; // null = explicit clear/skip
    name: string | null;
}

export async function pickWorkspaceProject(
    context: vscode.ExtensionContext,
    workspaceId: string,
    uid: string,
    placeholder: string,
): Promise<PickedProject | undefined> {
    interface Row {
        id: string;
        name: string;
    }
    let rows: Row[];
    try {
        const queried = await runQuery(context, '', {
            from: [{ collectionId: 'projects' }],
            where: {
                compositeFilter: {
                    op: 'AND',
                    filters: [
                        {
                            fieldFilter: {
                                field: { fieldPath: 'workspaceId' },
                                op: 'EQUAL',
                                value: { stringValue: workspaceId },
                            },
                        },
                        {
                            fieldFilter: {
                                field: { fieldPath: 'memberUids' },
                                op: 'ARRAY_CONTAINS',
                                value: { stringValue: uid },
                            },
                        },
                    ],
                },
            },
            limit: 200,
        });
        rows = queried
            .filter((r) => r.data.deleted !== true)
            .map((r) => ({
                id: r.id,
                name: typeof r.data.name === 'string' ? r.data.name : r.id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Couldn't load projects: ${msg}`);
        return undefined;
    }

    const items: vscode.QuickPickItem[] = [
        { label: '$(circle-slash) (none)', description: 'Leave notes unattached to a project' },
        ...rows.map((r) => ({ label: `$(folder) ${r.name}`, description: r.id })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: placeholder,
        ignoreFocusOut: true,
    });
    if (!picked) { return undefined; }
    if (picked.label.startsWith('$(circle-slash)')) {
        return { id: null, name: null };
    }
    const row = rows.find((r) => r.id === picked.description);
    return row ? { id: row.id, name: row.name } : undefined;
}
