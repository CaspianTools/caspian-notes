import * as vscode from 'vscode';
import { pairWithCaspianTools, type PairingResult } from './pair';

// Cloud sign-in for caspiantools.com — Notes-side mirror of the
// caspian-taskmaster equivalent.
//
// Flow (device pairing):
//   1. `pairWithCaspianTools()` (src/cloud/pair.ts) generates a session
//      id, registers it with the `startExtensionPairing` Cloud Function,
//      and opens caspiantools.com/{locale}/connect-extension in the
//      browser (with ?ext=notes so the page routes the vscode://
//      callback to *this* extension). The user logs in with any
//      provider supported on the web (Google / GitHub / email) and
//      picks a workspace + optional default project. The page calls
//      `completeExtensionPairing` server-side, which mints a Firebase
//      custom token. The page then dispatches a `vscode://` URI that
//      wakes our handler; pair.ts also polls `getExtensionPairing` as
//      a fallback in case the URI scheme is blocked.
//   2. We POST the custom token to Firebase Auth's signInWithCustomToken
//      REST endpoint. Returns idToken (1 h) and refreshToken (long-lived).
//   3. The refreshToken and uid are persisted in vscode.SecretStorage
//      (encrypted at rest on Win/Mac/Linux). The chosen workspaceId
//      lives in `globalState` — no need to encrypt; it's just a tenant
//      pointer, not a credential. The idToken is held in module memory
//      only and refreshed on demand via securetoken.googleapis.com.
//
// Storage keys are independent from Taskmaster on the same machine
// (`caspianNotes.cloud.*`) so the user can pair the two extensions to
// different workspaces if they want — same Firebase project, identical
// custom-token flow, just separate stored workspace pick + refresh
// token.

const FIREBASE_API_KEY = 'AIzaSyB8si3k4aqDGupwiquk13krhBQUlfhwep8';
const SIGN_IN_URL =
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`;
const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

const SECRET_REFRESH_TOKEN = 'caspianNotes.cloud.refreshToken';
const SECRET_UID = 'caspianNotes.cloud.uid';
const STATE_ACTIVE_WORKSPACE_ID = 'caspianNotes.cloud.activeWorkspaceId';
const STATE_ACTIVE_PROJECT_ID = 'caspianNotes.cloud.activeProjectId';

interface CachedIdentity {
    uid: string;
    refreshToken: string;
    idToken: string;
    // ms epoch; refreshed when within 60s of expiry.
    idTokenExpiry: number;
}

let cached: CachedIdentity | null = null;

export interface CloudIdentity {
    uid: string;
    workspaceId: string;
    workspaceName: string | null;
    defaultProjectId: string | null;
    defaultProjectName: string | null;
}

export async function connectCloud(
    context: vscode.ExtensionContext,
): Promise<CloudIdentity> {
    const pairing = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Connecting to caspiantools.com…',
            cancellable: true,
        },
        (_progress, token) => pairWithCaspianTools(token),
    );

    await signInWithPairing(context, pairing);
    return {
        uid: pairing.uid,
        workspaceId: pairing.workspaceId,
        workspaceName: pairing.workspaceName,
        defaultProjectId: pairing.defaultProjectId,
        defaultProjectName: pairing.defaultProjectName,
    };
}

async function signInWithPairing(
    context: vscode.ExtensionContext,
    pairing: PairingResult,
): Promise<void> {
    const signInRes = await fetch(SIGN_IN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            token: pairing.customToken,
            returnSecureToken: true,
        }),
    });
    if (!signInRes.ok) {
        const text = await signInRes.text().catch(() => '');
        throw new Error(`Firebase sign-in failed (${signInRes.status}). ${text}`.trim());
    }
    const signInJson = (await signInRes.json()) as {
        idToken?: string;
        refreshToken?: string;
        expiresIn?: string;
    };
    if (!signInJson.idToken || !signInJson.refreshToken || !signInJson.expiresIn) {
        throw new Error(
            `Firebase sign-in returned an unexpected response: ${JSON.stringify(signInJson)}`,
        );
    }

    cached = {
        uid: pairing.uid,
        refreshToken: signInJson.refreshToken,
        idToken: signInJson.idToken,
        idTokenExpiry:
            Date.now() + parseInt(signInJson.expiresIn, 10) * 1000 - 60_000,
    };

    await context.secrets.store(SECRET_REFRESH_TOKEN, cached.refreshToken);
    await context.secrets.store(SECRET_UID, cached.uid);
    await context.globalState.update(STATE_ACTIVE_WORKSPACE_ID, pairing.workspaceId);
    if (pairing.defaultProjectId) {
        await context.globalState.update(STATE_ACTIVE_PROJECT_ID, pairing.defaultProjectId);
    } else {
        await context.globalState.update(STATE_ACTIVE_PROJECT_ID, undefined);
    }
}

/** The workspaceId picked during pairing. Null when unpaired. */
export function getActiveWorkspaceId(
    context: vscode.ExtensionContext,
): string | null {
    return context.globalState.get<string>(STATE_ACTIVE_WORKSPACE_ID) ?? null;
}

/** Default projectId chosen at pairing time, used by uploadAll. Null = unattached. */
export function getActiveProjectId(
    context: vscode.ExtensionContext,
): string | null {
    return context.globalState.get<string>(STATE_ACTIVE_PROJECT_ID) ?? null;
}

export async function signOutCloud(
    context: vscode.ExtensionContext,
): Promise<void> {
    cached = null;
    await context.secrets.delete(SECRET_REFRESH_TOKEN);
    await context.secrets.delete(SECRET_UID);
    await context.globalState.update(STATE_ACTIVE_WORKSPACE_ID, undefined);
    await context.globalState.update(STATE_ACTIVE_PROJECT_ID, undefined);
}

export async function getCloudUid(
    context: vscode.ExtensionContext,
): Promise<string | null> {
    if (cached) { return cached.uid; }
    const stored = await context.secrets.get(SECRET_UID);
    return stored ?? null;
}

export async function isCloudSignedIn(
    context: vscode.ExtensionContext,
): Promise<boolean> {
    if (cached) { return true; }
    const refreshToken = await context.secrets.get(SECRET_REFRESH_TOKEN);
    return !!refreshToken;
}

/**
 * Returns a fresh ID token, refreshing it via the secure-token endpoint when
 * the cached one is within 60s of expiry. Returns `null` if the user isn't
 * signed in OR if the refresh fails (in the latter case, the local secrets
 * are cleared so the next sign-in starts clean).
 */
export async function getCurrentIdToken(
    context: vscode.ExtensionContext,
): Promise<string | null> {
    if (cached && cached.idTokenExpiry > Date.now()) {
        return cached.idToken;
    }

    const refreshToken = await context.secrets.get(SECRET_REFRESH_TOKEN);
    const uid = await context.secrets.get(SECRET_UID);
    if (!refreshToken || !uid) { return null; }

    const res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
    if (!res.ok) {
        await signOutCloud(context);
        return null;
    }
    const json = (await res.json()) as {
        id_token: string;
        refresh_token: string;
        expires_in: string;
    };

    cached = {
        uid,
        refreshToken: json.refresh_token,
        idToken: json.id_token,
        idTokenExpiry: Date.now() + parseInt(json.expires_in, 10) * 1000 - 60_000,
    };
    // Refresh tokens may rotate on each refresh — persist the new one.
    await context.secrets.store(SECRET_REFRESH_TOKEN, json.refresh_token);
    return cached.idToken;
}
