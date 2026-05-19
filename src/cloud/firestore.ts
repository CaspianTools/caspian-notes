import * as vscode from 'vscode';
import { getCurrentIdToken } from './auth';

// Minimal Firestore REST client for cloud writes from the extension host.
//
// We deliberately avoid the Firebase JS SDK: its modular Firestore code
// path uses XMLHttpRequest and IndexedDB shims that misbehave inside a
// Node-based VS Code extension host without polyfills, and the surface
// we need is small. REST keeps the dependency story clean and matches
// the same pattern used by caspian-taskmaster.
//
// Reference: https://firebase.google.com/docs/firestore/reference/rest

const PROJECT_ID = 'caspian-tools';
const FIRESTORE_BASE =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ── Value encoder ────────────────────────────────────────────────────────
// Maps JS values to Firestore "Value" objects. ISO date strings stay as
// stringValue (the web stores ISO strings, not Firestore timestamps —
// EXTENSION-SYNC-CONTRACT §3 / §10).

export function encodeValue(v: unknown): unknown {
    if (v === null || v === undefined) { return { nullValue: null }; }
    if (typeof v === 'string') { return { stringValue: v }; }
    if (typeof v === 'boolean') { return { booleanValue: v }; }
    if (typeof v === 'number') {
        return Number.isInteger(v)
            ? { integerValue: String(v) }
            : { doubleValue: v };
    }
    if (Array.isArray(v)) {
        return { arrayValue: { values: v.map(encodeValue) } };
    }
    if (typeof v === 'object') {
        const fields: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (val !== undefined) { fields[k] = encodeValue(val); }
        }
        return { mapValue: { fields } };
    }
    throw new Error(`encodeValue: unsupported type ${typeof v}`);
}

export function encodeFields(
    obj: Record<string, unknown>,
): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) { fields[k] = encodeValue(v); }
    }
    return fields;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeValue(v: any): any {
    if (v === null || v === undefined) { return null; }
    if ('nullValue' in v) { return null; }
    if ('stringValue' in v) { return v.stringValue; }
    if ('booleanValue' in v) { return v.booleanValue; }
    if ('integerValue' in v) { return parseInt(v.integerValue, 10); }
    if ('doubleValue' in v) { return v.doubleValue; }
    if ('timestampValue' in v) { return v.timestampValue; }
    if ('arrayValue' in v) {
        return (v.arrayValue.values ?? []).map(decodeValue);
    }
    if ('mapValue' in v) {
        return decodeFields(v.mapValue.fields ?? {});
    }
    return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeFields(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fields: Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(fields)) {
        result[k] = decodeValue(v);
    }
    return result;
}

// ── Authed transport ─────────────────────────────────────────────────────

async function authedFetch(
    context: vscode.ExtensionContext,
    url: string,
    init: RequestInit,
): Promise<Response> {
    const idToken = await getCurrentIdToken(context);
    if (!idToken) {
        throw new Error('Not signed in to caspiantools.com.');
    }
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${idToken}`);
    headers.set('content-type', 'application/json');
    return fetch(url, { ...init, headers });
}

// ── Public API ───────────────────────────────────────────────────────────

/** GET a Firestore document. Returns decoded fields, or null on 404. */
export async function getDoc(
    context: vscode.ExtensionContext,
    path: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any> | null> {
    const res = await authedFetch(context, `${FIRESTORE_BASE}/${path}`, {
        method: 'GET',
    });
    if (res.status === 404) { return null; }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Firestore GET ${path} failed (${res.status}). ${text}`.trim());
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json()) as { fields?: Record<string, any> };
    return decodeFields(json.fields ?? {});
}

/**
 * Run a structured query and return the matching docs as decoded
 * `{ id, data }` rows. Used by the inbound sync poll.
 *
 * `parent` is the collection's parent path (empty string for top-level
 * collections like `notes`). The structured-query shape follows the
 * Firestore REST docs:
 * https://firebase.google.com/docs/firestore/reference/rest/v1/StructuredQuery
 */
export async function runQuery(
    context: vscode.ExtensionContext,
    parent: string,
    query: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Array<{ id: string; data: Record<string, any> }>> {
    const url = parent
        ? `${FIRESTORE_BASE}/${parent}:runQuery`
        : `${FIRESTORE_BASE}:runQuery`;
    const res = await authedFetch(context, url, {
        method: 'POST',
        body: JSON.stringify({ structuredQuery: query }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Firestore runQuery failed (${res.status}). ${text}`.trim());
    }
    const json = (await res.json()) as Array<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        document?: { name: string; fields?: Record<string, any> };
    }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: Array<{ id: string; data: Record<string, any> }> = [];
    for (const row of json) {
        if (!row.document) { continue; }
        // document.name is `projects/{p}/databases/{d}/documents/{path}`.
        // We just want the doc id (last path segment).
        const id = row.document.name.split('/').pop() ?? '';
        out.push({ id, data: decodeFields(row.document.fields ?? {}) });
    }
    return out;
}

/**
 * PATCH a Firestore document. By default this is a merge: the request
 * carries an `updateMask` covering every key in `data`, so omitted
 * fields on the existing doc are left intact. Pass `replace: true` to
 * blow the doc away (omitted fields cleared). Creates the doc if it
 * doesn't exist.
 */
export async function setDoc(
    context: vscode.ExtensionContext,
    path: string,
    data: Record<string, unknown>,
    options?: { replace?: boolean; updateMask?: string[] },
): Promise<void> {
    const fields = encodeFields(data);
    const url = new URL(`${FIRESTORE_BASE}/${path}`);
    if (!options?.replace) {
        const mask = options?.updateMask ?? Object.keys(fields);
        for (const key of mask) {
            url.searchParams.append('updateMask.fieldPaths', key);
        }
    }
    const res = await authedFetch(context, url.toString(), {
        method: 'PATCH',
        body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Firestore PATCH ${path} failed (${res.status}). ${text}`.trim());
    }
}
