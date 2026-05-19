import * as crypto from 'crypto';
import * as vscode from 'vscode';

// Device-pairing client for caspiantools.com (Notes flavour).
//
// Flow (mirrors functions/src/extensionPairing.ts on the web side):
//
//   1. Generate a UUID v4 sessionId.
//   2. Call `startExtensionPairing` → registers the session server-side
//      with a 10-minute TTL.
//   3. `vscode.env.openExternal()` to
//      /en/connect-extension?session=...&ext=notes
//   4. Wait for completion via either:
//        a) URI handler callback (`vscode://CaspianTools.caspian-notes
//           /pair?session=...`) — fast path. extension.ts plumbs the
//           callback into `notifyPairingCallback()` below.
//        b) Polling `getExtensionPairing` every 3 s — fallback for when
//           the browser blocks custom URI schemes.
//   5. On success the function returns `{ uid, workspaceId, customToken,
//      defaultProjectId }`. The caller (auth.ts:connectCloud) feeds the
//      customToken into `signInWithCustomToken` and persists the refresh
//      token + uid + workspaceId + defaultProjectId.
//
// All state is per-call: the in-flight Map maps sessionId → resolver,
// scoped to the lifetime of one connect attempt.

const PROJECT_ID = 'caspian-tools';
const FUNCTIONS_REGION = 'us-central1';
const CASPIAN_WEB_URL = 'https://caspiantools.com';
const WEB_LOCALE = 'en';
const EXT_ID = 'notes';

const START_URL =
    `https://${FUNCTIONS_REGION}-${PROJECT_ID}.cloudfunctions.net/startExtensionPairing`;
const GET_URL =
    `https://${FUNCTIONS_REGION}-${PROJECT_ID}.cloudfunctions.net/getExtensionPairing`;

const POLL_INTERVAL_MS = 3_000;
const PAIRING_TIMEOUT_MS = 10 * 60 * 1000;

// Pending sessionId → resolver. The URI handler in extension.ts resolves
// the matching entry as soon as the browser dispatches our callback URI.
const pendingCallbacks = new Map<string, () => void>();

export function notifyPairingCallback(sessionId: string): void {
    const resolver = pendingCallbacks.get(sessionId);
    if (resolver) { resolver(); }
}

export interface PairingResult {
    uid: string;
    workspaceId: string;
    workspaceName: string | null;
    defaultProjectId: string | null;
    defaultProjectName: string | null;
    customToken: string;
}

interface StartResponse {
    result?: { ok: boolean };
    error?: { message?: string };
}

interface GetResponse {
    result?: {
        status: 'pending' | 'ready' | 'consumed' | 'expired' | 'not-found';
        uid?: string | null;
        workspaceId?: string | null;
        workspaceName?: string | null;
        defaultProjectId?: string | null;
        defaultProjectName?: string | null;
        customToken?: string;
    };
    error?: { message?: string };
}

/**
 * Top-level entry point. Drives the whole device-pairing dance from the
 * extension side. Throws on cancellation, expiry, or HTTP error; the
 * caller wraps this in `vscode.window.withProgress` and surfaces failures
 * via showErrorMessage.
 */
export async function pairWithCaspianTools(
    cancelToken: vscode.CancellationToken,
): Promise<PairingResult> {
    const sessionId = crypto.randomUUID();

    const startBody = {
        data: {
            sessionId,
            // Notes don't carry a repo binding — the field is metadata only
            // on the web side (it's used for UX hints like "Connecting
            // CaspianTools/caspian-taskmaster…") and a null value renders a
            // generic title.
            repoFullName: null,
            clientName: 'caspian-notes-vscode',
            clientVersion: vscode.extensions.getExtension('CaspianTools.caspian-notes')
                ?.packageJSON?.version ?? null,
        },
    };
    const startRes = await fetch(START_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(startBody),
    });
    if (!startRes.ok) {
        const text = await startRes.text().catch(() => '');
        throw new Error(`Pairing start failed (${startRes.status}). ${text}`.trim());
    }
    const startJson = (await startRes.json()) as StartResponse;
    if (startJson.error || !startJson.result?.ok) {
        throw new Error(
            `Pairing start error: ${startJson.error?.message ?? 'unknown'}`,
        );
    }

    // Open the browser. We don't wait — the user does the rest of the
    // flow there and either dispatches our vscode:// URI back or we poll.
    // The &ext=notes query routes the dispatched URI to the caspian-notes
    // extension instead of caspian-taskmaster.
    const webUrl = vscode.Uri.parse(
        `${CASPIAN_WEB_URL}/${WEB_LOCALE}/connect-extension?session=${encodeURIComponent(sessionId)}&ext=${EXT_ID}`,
    );
    void vscode.env.openExternal(webUrl);

    const result = await awaitPairing(sessionId, cancelToken);
    return result;
}

async function awaitPairing(
    sessionId: string,
    cancelToken: vscode.CancellationToken,
): Promise<PairingResult> {
    const startedAt = Date.now();

    const callbackPromise = new Promise<void>((resolve) => {
        pendingCallbacks.set(sessionId, resolve);
    });
    const cancelPromise = new Promise<never>((_, reject) => {
        cancelToken.onCancellationRequested(() => {
            reject(new Error('Connect cancelled.'));
        });
    });

    try {
        while (Date.now() - startedAt < PAIRING_TIMEOUT_MS) {
            const tickPromise = sleep(POLL_INTERVAL_MS);
            await Promise.race([callbackPromise, tickPromise, cancelPromise]);

            const fetched = await fetchPairing(sessionId);
            if (fetched.status === 'ready') {
                if (!fetched.customToken || !fetched.uid || !fetched.workspaceId) {
                    throw new Error('Pairing returned an incomplete payload.');
                }
                return {
                    uid: fetched.uid,
                    workspaceId: fetched.workspaceId,
                    workspaceName: fetched.workspaceName ?? null,
                    defaultProjectId: fetched.defaultProjectId ?? null,
                    defaultProjectName: fetched.defaultProjectName ?? null,
                    customToken: fetched.customToken,
                };
            }
            if (fetched.status === 'expired') {
                throw new Error('Pairing session expired. Click Connect again.');
            }
            if (fetched.status === 'consumed') {
                throw new Error(
                    'Pairing session was already used. Click Connect again to start a fresh one.',
                );
            }
            if (fetched.status === 'not-found') {
                throw new Error('Pairing session not found on the server.');
            }
            // status === 'pending' → keep waiting.
        }
        throw new Error('Pairing timed out. Please try again.');
    } finally {
        pendingCallbacks.delete(sessionId);
    }
}

async function fetchPairing(sessionId: string): Promise<NonNullable<GetResponse['result']>> {
    const res = await fetch(GET_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { sessionId } }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Pairing poll failed (${res.status}). ${text}`.trim());
    }
    const json = (await res.json()) as GetResponse;
    if (json.error || !json.result) {
        throw new Error(`Pairing poll error: ${json.error?.message ?? 'unknown'}`);
    }
    return json.result;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
