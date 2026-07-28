# Caspian Notes — Threat Model

| Version | Date | Notes |
|---|---|---|
| 0.1.0 | 2026-04-24 | Initial model. |
| 0.4.0 | 2026-04-25 | Renamed from "Caspian Prompt"; storage paths and class names updated. |
| 1.3.4 | 2026-04-25 | Refined §C (textContent invariant restored after the static-`innerHTML` callsites for the empty-state heading and the pin-button SVG were converted to `createElement`/`createElementNS`); added §F covering the markdown-preview rendering surface introduced in 1.3.0. |
| 1.4.8 | 2026-07-28 | Added §G for the optional cloud-sync boundary introduced in 1.4.0, which this document had not previously covered: new trust boundary 4, new assets (refresh token, uid, workspace pointer), the public-by-design status of the bundled Firebase Web API key, and a correction to the now-false "No sync" residual risk. |

## Assets

| Asset | Why it matters |
|---|---|
| Note content | May contain trade secrets, customer-identifying context, credentials copy-pasted into a template, or personal writing the user wants private. |
| Note metadata | Titles and tags can leak intent even when bodies are encrypted at rest. |
| Extension storage path | Writable location inside VS Code's global storage; must not be abused to write outside of it. |
| Cloud refresh token + uid | Long-lived Firebase credential held in `vscode.SecretStorage` once the user pairs (1.4.0+). Exchangeable for an id token, and therefore for read/write access to that user's cloud notes. The single highest-value secret the extension holds. |
| Active workspace / project id | Stored in `globalState`, not encrypted. A tenant pointer, not a credential — it names which workspace to sync with but grants nothing on its own. |

## Trust boundaries

1. **Extension host ↔ Webview** — webview runs untrusted-UI-style in its own origin; communicates only via `postMessage`.
2. **Extension ↔ Filesystem** — reads/writes `.md` files under `context.globalStorageUri/notes/`.
3. **Extension ↔ Other extensions** — the **Chat** action invokes a user-configured command; the receiving extension is outside this threat model.
4. **Extension ↔ caspiantools.com / Firebase** — *only if the user opts in by pairing* (1.4.0+). Crosses the machine boundary to `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, and the project's Firestore REST endpoint. Unpaired, this boundary does not exist and no note ever leaves the device. See §G.

## Adversaries & mitigations

**A. Malicious workspace / repo**

- *Threat:* the repo opened in VS Code tries to exfiltrate notes via a malicious configuration file.
- *Mitigation:* notes live in `globalStorageUri`, not in the workspace. Workspace-level settings cannot read or write there.

**B. Compromised chat extension**

- *Threat:* user misconfigures `chatCommand` to point at a malicious extension that logs the note body.
- *Mitigation:* the command ID is an explicit user setting with a documented default. We do not invoke anything else automatically.

**C. Webview XSS**

- *Threat:* a note body containing script tags is rendered unsanitized and executes inside the webview.
- *Mitigation:* all note text is rendered via `textContent` (never `innerHTML`), and a strict CSP (`script-src 'nonce-…' webview.cspSource`; `default-src 'none'`; `img-src webview.cspSource data:`) prevents any inline/remote script execution, `on*` event handlers, `javascript:` URIs, remote images, and iframes even if a sink slipped in. Inline SVG decoration (e.g. the pin button) is built via `createElementNS`, never via HTML string concatenation.
- *Out of scope for this defense:* the markdown-preview pane — see §F.

**D. Filesystem path traversal**

- *Threat:* crafted `id` in frontmatter escapes the storage directory on read/write.
- *Mitigation:* `id` is always set server-side via `crypto.randomUUID()`; on write, we compose the path from `path.join(dir, id + '.md')`. On read, we iterate `readdir` results — the filename is never user-controlled.

**E. Dependency compromise**

- *Threat:* `gray-matter` or a transitive dependency ships a backdoor.
- *Mitigation:* pinned minor range in `package.json`. We run no code at install time (no postinstall scripts in our own package). We do not execute user input as code.

**F. Markdown preview HTML injection**

- *Threat:* a note body containing raw HTML (e.g. `<script>`, `<img onerror=…>`, `<a href="javascript:…">`, `<iframe src=…>`) reaches the editor's Markdown preview pane via `marked.parse(body)` → `innerHTML`. Marked passes raw HTML through to its output by default (the legacy `sanitize` option was removed in v9). The note body in question may have been imported from an untrusted .md file or library JSON.
- *Mitigation:* the webview CSP blocks every JavaScript sink such markup could open. `script-src 'nonce-X' webview.cspSource` requires a nonce on every executable script — inline `<script>` tags injected via markdown have no nonce and never execute. The same directive blocks inline `on*` event handlers and `javascript:` URIs (both require `unsafe-inline`). `default-src 'none'` blocks `<iframe>` entirely. `img-src webview.cspSource data:` blocks remote image loads, neutralizing tracking pixels and the `<img onerror>` exfil pattern. The preview is therefore safe under the current CSP without a runtime sanitizer (DOMPurify, sanitize-html).
- *Residual risk:* the preview can render visible HTML (formatting, links, lists). A hostile note could draw a fake "Save your password to unlock" UI. We accept this — the user wrote or imported the note themselves, and the same risk exists for any markdown-rendering tool.
- *Tested by:* CSP review on every release. If the CSP in `notePanel.ts` is ever loosened to add `'unsafe-inline'` to `script-src` or to broaden `default-src`, this mitigation must be re-evaluated and a runtime sanitizer added.

**G. Cloud sync (opt-in, 1.4.0+)**

- *Threat:* the bundled Firebase Web API key (`src/cloud/auth.ts`) is extracted from the VSIX and used to attack the project.
- *Mitigation:* nothing to extract — it is a public project identifier, not a credential. The identical value is served to every visitor of caspiantools.com as `NEXT_PUBLIC_FIREBASE_API_KEY`. It lets the holder *address* the project's Identity Toolkit endpoint; it authorizes nothing. Every read and write is gated by Firebase Auth plus the Firestore security rules, which scope notes to `memberUids` of the owning workspace. Secret scanners (including Open VSX's, rule `gcp-api-key`) match it on shape alone, hence the `secret-detector:ignore` marker on that line — justified here precisely because the value is public, and not to be reused for anything that isn't.
- *Recommended hardening (Google Cloud Console, outside this repo):* restrict the key to the Identity Toolkit and Token Service APIs. An unrestricted key is still not a credential, but it can be pointed at any other billable API enabled on the project.

- *Threat:* the stored refresh token is stolen from the local machine and replayed to impersonate the user.
- *Mitigation:* it is held in `vscode.SecretStorage`, which is backed by the OS keychain (Credential Manager / Keychain / libsecret) and encrypted at rest — never in `globalState`, never in a note file, never in a setting. It is written only after a successful pairing and cleared on **Disconnect**. An attacker who already has code execution as the user can read it; that is the same trust level at which they could read the notes directly, so it is not an escalation.

- *Threat:* a malicious web page triggers the `vscode://` pairing callback to bind the extension to an attacker-controlled workspace.
- *Mitigation:* pairing is initiated *from the extension*, which generates the session id and only accepts a callback matching the session it started. The custom token is minted server-side by `completeExtensionPairing` for the account that authenticated in the browser. A page cannot forge a session the extension never opened.

- *Threat:* sync loops or fights with the web client, corrupting notes.
- *Mitigation:* every write carries the EXTENSION-SYNC-CONTRACT writer tag (`extension:<uid>:<sessionPrefix>`); the `onNoteWrite` Cloud Function skips fan-out for extension-tagged writes. `memberUids` is server-managed and no longer asserted by the extension on update (see the 1.4.5 CHANGELOG entry).

- *Residual risk:* once paired, note content leaves the device and is stored server-side under caspiantools.com's own threat model. Users who need notes to stay local should simply not pair — cloud sync is off until an explicit **Connect**.

## Known residual risks

- **No content-at-rest encryption.** An attacker with filesystem access to `globalStorageUri` reads notes in cleartext. Treat this the same as any other local VS Code state (snippets, history). Full-disk encryption is the recommended mitigation.
- **No implicit sync.** `globalStorageUri` is not synced by VS Code Settings Sync, and notes stay on the device unless the user explicitly pairs with caspiantools.com (1.4.0+, see §G). Users who copy the folder manually take responsibility for protecting it in transit.
- **Chat-command side effects.** When the user invokes **Chat**, the extension transfers the note body to the configured command. What happens next is outside our control.

## Assumptions

- The user trusts the VS Code process and the extensions they install.
- The user's filesystem is not shared with untrusted users.
- The VS Code webview API enforces CSP and `localResourceRoots` as documented.
