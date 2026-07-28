# Changelog

All notable changes to **Caspian Notes** will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

## [1.4.6] - 2026-07-28

### Changed
- **Reconciled the two divergent `main` lines.** The local branch had carried the entire unreleased 1.4.x cloud-sync line (1.4.0 → 1.4.5, six commits) while `origin/main` had moved on independently with three commits of its own: the 1.3.6 maintenance republish, the filled-in Announcements category ID in `CLAUDE.md`, and the Claude Code worktree setup. Neither side had ever seen the other. No source file conflicted — the collision was confined to the version marker in `package.json` and the position of the 1.3.6 entry in this file, which now sits in its correct chronological slot between 1.4.0 and 1.3.5. **1.4.0 through 1.4.5 were never tagged or released**, so this is the first public release of the whole cloud-sync line; the release notes for those versions are the entries below.
- **`package-lock.json` re-synced.** It had been stuck at 1.3.5 since before 1.4.0 — the `npm install` step of the version bump was skipped for all six 1.4.x commits, so the lock never recorded any of them. Because the local side had left those lines untouched, git saw no conflict during the merge and silently resolved the lock to origin's 1.3.6 while `package.json` said 1.4.5. Regenerated at 1.4.6, and the two are consistent again.
- **Repository URLs corrected from `Caspian-Explorer` to `CaspianTools`.** The org rename had only been applied inside `CLAUDE.md`; the CI badge in `README.md`, the clone commands in `BUILD.md` / `QUICKSTART.md`, the advisory link in `SECURITY.md`, and `repository.url` in `package.json` all still pointed at the old owner. GitHub was redirecting them, so nothing was broken — they are simply correct now. The `LICENSE` copyright holder is unchanged (it names a person, not a URL).

### Added
- **Claude Code worktree isolation** (arriving via the merge). `.worktreeinclude` declares which gitignored files get copied into each new worktree, `.gitignore` now excludes `.claude/worktrees/` so parallel sessions never surface as untracked files in the main checkout, and `CLAUDE.md` gains a "Worktrees & the ship rule" section documenting how the release flow adapts inside a worktree (commit on the feature branch, land serially, rebase-and-resolve in the worktree, never tag from one without an explicit go-ahead).

### Fixed
- **`BUILD.md` project structure was three minor versions stale.** The tree still described the pre-1.4.0 layout — no `src/cloud/`, no test files, no `scripts/`. It now reflects the real source tree, and the Test / Audit npm scripts (`npm test` via vitest, `npm run audit`) are documented alongside Lint instead of being discoverable only from `package.json`.

## [1.4.5] - 2026-07-27

### Fixed
- **Notes created in VS Code were invisible to every colleague, and updates to shared notes were rejected outright.** `buildNotePayload` sent `memberUids: [uid]` on *every* push. Two consequences, both only visible in a workspace with more than one member:
  - On a **create**, `memberUids` is the tenancy anchor — the web's per-note read rule checks it and every live query filters on `array-contains uid` — so `[uid]` produced a note only its author could see. The comment here claimed `onWorkspaceMemberChange` would fan the value out to the full member list; it does not. That trigger fires on a workspace-document *update*, so it only re-mirrors when membership actually CHANGES, and a note created wrong in a stable workspace stayed wrong forever. The first push now sends the workspace's real `memberUids`, read from `/workspaces/{wsId}` once per outbound sweep (falling back to `[uid]` if that read fails).
  - On an **update**, caspiantools.com now pins `memberUids` (`tenancyUnchanged()` in `firestore.rules`), and `setDoc`'s `updateMask` covers every key in the payload — so sending `[uid]` for a note the server had widened to the full workspace failed with `PERMISSION_DENIED`, silently breaking sync for that note. `memberUids` is no longer sent on updates at all; it is server-managed state (EXTENSION-SYNC-CONTRACT §3), and the only reason to send it is to satisfy the create rule. `syncedAt` is the create/update discriminator — it is stamped only after a successful push or an inbound apply, so its absence means "this note does not exist in the cloud yet".

## [1.4.4] - 2026-05-21

### Added
- **Per-note sync marker in the tree description.** Each note in the Caspian Notes view now carries a small unicode marker after its tags: `✓` synced, `⟳` pending push to Caspian Tools, `⚠` conflict, `(local)` never paired. The tooltip on hover gains a one-line description (e.g. "Synced 2m ago"). Logic mirrors the web's NoteSyncBadge but with the extra `(local)` state the extension cares about — the web treats every Firestore note as synced by definition.
- New tiny `src/timeAgo.ts` helper (`formatRelativeShort`) used by the tooltip. Independent of caspiantools' `lib/utils.ts:formatRelativeDate` so the extension stays self-contained.

## [1.4.3] - 2026-05-21

### Fixed
- **VSIX now bundles `node_modules/`.** v1.4.0 through v1.4.2 were all built with `vsce package --no-dependencies`, which skips both the `npm install --production` step AND bundling `node_modules/`. The installed extension was missing `gray-matter` (a runtime dependency of `noteStore.ts`), so the extension module failed to load at `require()` time with `Cannot find module 'gray-matter'`. VS Code logged an activation error and NO commands registered — which is why every welcome-panel button and view-title-toolbar icon across 1.4.0–1.4.2 produced "command not found". 1.4.3 builds with the default `vsce package` (which runs `npm install --production` and bundles `node_modules/` per the `.vscodeignore`) and is the first actually-functional release of the cloud-sync line. The defensive layers from 1.4.1/1.4.2 (outer try/catch around `activate`, per-step `log()` probes, `onStartupFinished` activation, popup on crash) remain — they were aimed at the wrong problem but are still useful for diagnosing any future activation issues.

## [1.4.2] - 2026-05-20

### Fixed
- **Activation crashes are now visible.** v1.4.1 wrapped the cloud-specific setup blocks in try/catch but left lines 60–120 of `activate()` (NoteStore construction, tree provider registration, file watcher, etc.) bare. A throw in that range still left the extension half-activated with welcome-panel buttons surfacing "command not found". The entire `activate()` body is now wrapped in an outer try/catch; on failure the user sees a popup ("Caspian Notes failed to activate: …") with a "Show Developer Tools" action that opens the console for the stack trace. Per-step `log()` probes (output channel + `console.log`) emit a line before every synchronous setup step, so the first MISSING line identifies the failing step.

### Changed
- **Explicit `activationEvents`: `onStartupFinished`, `onUri`.** Declaring this turns OFF the implicit `onCommand:*` derivation and forces activation to happen as soon as the VS Code window finishes loading — no user click required. Logs and any thrown error now appear immediately on startup, which is the only reliable way to diagnose the kind of silent activation failure v1.4.1 was hitting. `onUri` is kept explicitly for the device-pairing callback URI.

## [1.4.1] - 2026-05-20

### Fixed
- **Activation no longer fails silently on cloud-setup errors.** v1.4.0 ran the cloud-related setup (status bar item, URI handler, auto-start of the sync engine) *before* the `vscode.commands.registerCommand(...)` block. If any of those threw — and in practice on at least one machine they did, surfacing the cryptic "command 'caspianNotes.open' not found" when the user clicked the tree-view welcome buttons — the whole `activate()` function bailed and no commands ended up registered. The function is now restructured so every command is registered first, and each cloud-specific block (status bar, URI handler, auto-start) is wrapped in its own `try/catch`. Failures inside the cloud blocks are logged to a new `Caspian Notes` output channel + `console.error` and never break activation.

### Added
- **"Connect to Caspian Tools" link in the tree-view welcome panel.** Below the existing "New note" / "Open full library" links, hidden once paired (the panel switches to a "Synced with Caspian Tools" confirmation line instead).
- **$(cloud) icon button in the Notes view title toolbar.** Always visible at the top of the Caspian Notes view: pre-pairing it runs `caspianNotes.connect`; post-pairing it runs `caspianNotes.cloudStatus` (the quick-pick of sync actions). Driven off the new `caspianNotes.cloud.signedIn` context key, which is set on activation, after Connect, and after Disconnect.
- **Activation logging.** Every step of `activate()` writes a line to the new `Caspian Notes` output channel: entry, commands registered, status bar ok / failed, URI handler ok / failed, auto-start sync result. Mirror lines go to `console.log` so you can grep Help → Toggle Developer Tools too.

## [1.4.0] - 2026-05-19

### Added
- **Optional two-way cloud sync with Caspian Tools.** Pair the extension to a workspace on caspiantools.com via the new `Caspian Notes: Connect` command — opens the browser, you pick a workspace + (optional) default project, the page dispatches a `vscode://CaspianTools.caspian-notes/pair?session=…` URI back to the extension. Sign-in flow is identical to the shipped Caspian-Taskmaster pattern: Firebase custom token → `signInWithCustomToken` REST → refresh token persisted in `vscode.SecretStorage` (key prefix `caspianNotes.cloud.*`, independent from Taskmaster's prefix so you can sign each extension into a different workspace on the same machine). Once paired, two coordinated 15s loops run: outbound sweeps local notes with `cloudDirty:true` to the cloud `/notes` collection, inbound polls `updatedAt > cursor` for cross-device updates. **No GitHub leg** — notes have no GitHub representation, so `cloudDirty:false` after the Firestore PATCH is the terminal state. Loop-prevention via the standard EXTENSION-SYNC-CONTRACT writer-tag (`extension:<uid>:<sessionPrefix>`); the matching `onNoteWrite` Cloud Function on the web side skips fan-out on extension/github writer tags.
- **`Caspian Notes: Upload All Notes to Caspian Tools` command.** Bootstrap-style bulk push of every existing local note to the paired workspace, with a default-project picker (or `(none)` to leave notes unattached). Flips `cloudDirty:true` on every active note and triggers an immediate outbound tick.
- **`Caspian Notes: Assign Note to Project` command** (palette + tree-view item context menu). Pops a quick-pick over the workspace's projects (live-fetched from the cloud via `runQuery` against `/projects` filtered by your `memberUids`), writes `projectId` to the local note, and pushes within 15 s.
- **Cloud status bar item.** Right side of the status bar shows `$(cloud) Notes synced` / `$(cloud-upload) Notes N pending` / `$(circle-slash) Notes offline`. Click opens a quick-pick of the cloud commands. Auto-shown when the extension activates if you're already signed in.
- **`.deleted/` tombstone folder** for soft-delete. Deleting a note now moves the file to `${globalStorageUri}/notes/.deleted/<id>.md` and stamps `deleted:true` so the next outbound tick syncs the delete to the cloud. The active folder no longer contains the file; `list()` and `get()` are unchanged (they still don't surface tombstones). Cloud-side `deleted:true` propagates back via the inbound loop using the same tombstone mechanism.

### Changed
- **Pin/unpin now bumps `updatedAt`.** Required for cloud sync: the inbound poll keys on `updatedAt > cursor`, so a pin-only edit must bump the timestamp or it wouldn't sync until the next non-pin edit. The visible effect is that a freshly-pinned note jumps to the top of the pinned bucket; the unpinned bucket is unaffected because pin sorts ahead of recency.
- **Note frontmatter gains optional fields**: `localId`, `workspaceId`, `projectId`, `cloudDirty`, `syncedAt`, `updatedBy`, `deleted`, `deletedAt`. Legacy notes still parse fine — `localId` is back-filled from the file's UUID stem on first read so the cloud doc id (`${workspaceId}_${localId}`) is stable from either side.
- **`update()` accepts `projectId: string | null`** to set or clear the field; `delete()` writes a tombstone via the new flow described above; new internal helpers `getDirtyNotes()` / `upsertFromCloud()` / `markCloudSynced()` / `markAllDirty()` / `getSessionPrefix()` mirror the IssueStore API the sync engine expects.

## [1.3.6] - 2026-05-07

### Changed
- **Maintenance release — no functional changes.** Repackaged the VSIX from a freshly installed dependency tree to refresh the published artifact. Source, configuration, and bundled assets are identical to 1.3.5.

## [1.3.5] - 2026-04-25

### Added
- **Hero screenshot in README.** Replaced the placeholder Screenshots section with `media/screenshots/main_screenshot.jpg` — a single composite shot of the activity-bar tree alongside the masonry grid with example prompt notes. Marketplace listings render the README from inside the VSIX, and the screenshot is bundled (no `.vscodeignore` exclusion of `media/`).

## [1.3.4] - 2026-04-25

### Security
- **Restored the `textContent`-only invariant** documented in [THREAT_MODEL.md](THREAT_MODEL.md) §C. Two webview callsites that were using static-string `innerHTML` (the empty-state heading at `media/main.js:186` and the pin-button SVG at `media/main.js:236`) now build their DOM via `createElement`/`createElementNS`. Neither was an exploitable XSS — both strings were literals — but the invariant matters for static analysis and future-proofing.
- **Documented the markdown-preview rendering surface** as new [THREAT_MODEL.md](THREAT_MODEL.md) §F. The preview pane introduced in 1.3.0 sends `marked.parse(body)` into `innerHTML`, which is safe under the existing CSP (`script-src 'nonce-X' webview.cspSource`; `default-src 'none'`; `img-src webview.cspSource data:`) — that CSP blocks every JavaScript sink raw markdown HTML could expose (inline `<script>`, `on*` handlers, `javascript:` URIs, remote `<img>`, `<iframe>`). Added an inline comment at `media/main.js:478` so future contributors don't add a sanitizer reflexively or weaken the CSP without re-evaluating §F.
- **Bumped `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` from ^6.0.0 to ^8.0.0.** Resolves all 6 high-severity `npm audit` findings (transitive on `@typescript-eslint/typescript-estree`). v8 requires ESLint ≥8.57 and Node ≥18.18, both satisfied.
- **Hardened `.gitignore`** with patterns for `.env`, `.env.*`, `credentials.json`, `serviceAccountKey*.json`, `*.pem`, `*.key`. The extension stores no credentials, so this is purely defense-in-depth against accidental check-ins of unrelated files in dev workspaces.

### Notes (not changed)
The remaining 5 moderate `npm audit` findings (`@vscode/vsce` → `@azure/identity` → `@azure/msal-node` → `uuid`, plus `ovsx`) are dev-only and never ship in the VSIX. `npm audit fix --force` would *downgrade* `ovsx` from 0.10.11 to 0.9.4, losing features. Accepted risk.

## [1.3.3] - 2026-04-25

### Fixed
- **Editor modal now fills the full webview height.** Previously the New / Edit note dialog was vertically centered inside the backdrop and capped at `max-height: 92vh`, which made it look like a half-height popup when the library was opened in a narrow panel (e.g. the secondary sidebar). Backdrop now uses `align-items: stretch`, the modal takes `height: 100%` of the available area, and the body textarea / Markdown preview flex-grow to fill remaining space inside the modal. Min-heights for textarea and preview reduced from 220 px to 120 px so the modal still renders correctly in very short panels.

## [1.3.2] - 2026-04-25

### Changed
- **Pinned all text files to LF line endings via new `.gitattributes`.** Neutralizes Git's `core.autocrlf=true` default on Windows machines so contributors no longer see noisy LF↔CRLF diffs on files they didn't touch. Binary assets (`*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.ico`, `*.svg`, `*.woff`, `*.woff2`, `*.vsix`) are explicitly marked binary so Git never normalizes them.

## [1.3.1] - 2026-04-25

### Added
- **GitHub Actions CI workflow** (`.github/workflows/ci.yml`) — runs lint, compile, tests, and `npm audit` on every push and PR.
- **GitHub Actions release workflow** (`.github/workflows/release.yml`) — packages a VSIX and creates a GitHub Release with auto-extracted CHANGELOG notes when a `v*` tag is pushed. Marketplace / Open VSX publish steps are scaffolded but commented out until the user adds tokens.
- **`npm run audit`** convenience script.
- **README badges** for Marketplace version / installs / rating, license, and CI status.
- **CLAUDE.md**: filled in the now-known caspian-notes repo GraphQL ID (`R_kgDOSLnYTw`); the Announcements category ID still requires Discussions to be enabled on the repo first.

## [1.3.0] - 2026-04-25

### Added
- **Export / Import library.** New commands `Caspian Notes: Export Library to JSON…` and `Caspian Notes: Import Library from JSON…`. Export writes a `caspian-notes-YYYY-MM-DD.json` snapshot of every note; import reads any prior export (or a bare-array variant) and ingests them with fresh IDs so duplicates can't collide.
- **Variable templating.** Note bodies can include `{{var}}` placeholders. Built-ins (`date`, `time`, `datetime`, `selection`, `filename`, `filepath`) resolve automatically; unknown variables prompt the user via QuickInput. Templates expand on Copy / Insert / Send to Chat (not on Edit). Cancelling any prompt aborts the action.
- **Markdown preview tab** in the editor modal. Toggle Edit/Preview alongside the body field. Rendering uses `marked` (ESM, vendored) — strict CSP keeps the preview safe from script execution.
- **Tag-grouped tree view.** New setting `caspianNotes.treeGrouping` (`flat` | `byTag`) and a view-title button ($(list-tree)) to toggle. In byTag mode notes are listed under their tags with an "Untagged" bucket; toggle is per-user (Global) so it persists across workspaces.

### Changed
- Action dispatch consolidated into `src/noteActions.ts`. Both the webview and the tree-command surfaces now run through one `performAction(store, action, id, presenter)` pipeline. Removes ~50 lines of duplication.
- Added `marked` (~30 KB) to runtime deps and `vendor/marked.esm.js` to the build output. CSP is unchanged — preview HTML is rendered via `innerHTML` but inline scripts and `onerror` handlers are blocked by the existing nonce-based `script-src`.

### Test
- 35 unit tests total (was 19) — added `templates.test.ts` (14 tests) and `importNotes` cases in `noteStore.test.ts` (2 added).

## [1.2.0] - 2026-04-25

### Added
- **Fuzzy search** via `fuse.js`. Typing `rvw` matches "review", `clde` matches "claude". The substring path is kept as a fallback for single-character queries (where fuzzy is too noisy). Search runs across title, tags, and body with weighted scoring.
- **Tag autocomplete** in the editor's tags input. Type a partial tag to see existing tags as a dropdown — Tab/Enter to accept, ↑/↓ to navigate, Esc to dismiss.
- **Undo on delete.** Confirmation modal is gone; delete is immediate and a non-modal toast offers an Undo button. Restoring preserves the original `id`, `createdAt`, and `updatedAt`.
- **Duplicate note** — right-click a tree item → "Duplicate". Creates a copy with `(copy)` suffix; same tags, body, and a fresh id.
- **Pin / star** — pinned notes always sort to the top. Click the pin icon on a card (top-left, visible on hover or always when pinned) or right-click a tree item → "Pin / Unpin". Pinned notes get the `pinned` ThemeIcon in the sidebar tree. Toggling pin does NOT bump `updatedAt`.
- **README banner** — `media/banner.png` is now used as the hero image at the top of the README for marketplace listings.

### Changed
- `Note` model now has a `pinned: boolean` field; serialized in frontmatter only when `true` (keeps existing files clean).
- `NoteStore.list()` sort: pinned notes first, then by `updatedAt` desc among pinned and among unpinned independently.
- Webview script tag is now `type="module"` and the entry script imports `fuse.js` from `media/vendor/fuse.min.mjs`. CSP `script-src` extended with `webview.cspSource` to permit ESM imports while keeping the inline-script nonce requirement.

### Test
- 19 unit tests for `NoteStore` (was 14) — added coverage for pin sort, pin updatedAt semantics, restore round-trip, default pinned value.

## [1.1.0] - 2026-04-25

### Added
- **Filesystem watcher** on `globalStorage/notes/`. External edits (manual edits, restores from backup, sync clients) are reflected in the UI without a reload.
- **Parse-error notifications.** Notes whose frontmatter fails to parse no longer disappear silently — a one-time warning is shown per file with a "Reveal in Folder" action so the user can repair them.
- **Vitest test suite** for `NoteStore` covering CRUD, tag normalization, sort order, parse-error events, and round-trip stability (14 tests).

### Changed
- `NoteStore.list()` now reads files in parallel via `Promise.all`. ~10× faster for large libraries.
- `NoteStore` constructor takes a directory path directly; new `NoteStore.fromContext()` factory builds the path from `vscode.ExtensionContext`. Makes the store unit-testable without a vscode mock.
- `chatCommand` setting is now validated — must contain `"chat"` (case-insensitive). Destructive built-ins like `workbench.action.quit` are rejected with a one-time warning, with fallback to the default. Defends against malicious workspace-level config.
- Tree-view tooltip now sets `isTrusted = false` and `supportHtml = false`, and escapes markdown control characters in note title/body before rendering.
- TypeScript: enabled `noImplicitOverride`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch` in `tsconfig.json`.
- ESLint: now extends `@typescript-eslint/recommended` with `prefer-const` and unused-var warnings.

### Fixed
- Round-trip stability: every save no longer accumulated a trailing newline in the body. Caught by a new test.

## [1.0.1] - 2026-04-25

### Changed
- Toolbar button label shortened from `+ New note` to `+ New`. Empty-state hint and quickstart doc updated to match.

## [1.0.0] - 2026-04-25

### Changed
- First stable release. No functional changes from 0.4.1 — the bump signals that the rebrand to Caspian Notes (commands, settings, view IDs, storage paths, branding icon) is complete and ready for marketplace submission.

## [0.4.1] - 2026-04-25

### Changed
- Marketplace / Extensions-detail icon now uses `media/favicon.png` (the user-supplied brand mark) instead of the inherited shield. Top-level `icon.png` removed.

## [0.4.0] - 2026-04-25

### Changed
- **Renamed extension from "Caspian Prompt" to "Caspian Notes."** The package id (`caspian-prompt` → `caspian-notes`), display name, all command IDs (`caspianPrompt.*` → `caspianNotes.*`), settings keys, view IDs, and on-disk storage subdirectory (`prompts/` → `notes/`) all change. Internal types/classes renamed to `Note`, `NoteStore`, `NotePanel`, `NoteTreeProvider`.

### Breaking
- VS Code treats this as a brand-new extension (`caspiantools.caspian-notes`). The old `caspiantools.caspian-prompt` install must be uninstalled manually from the Extensions view.
- Existing data does **not** migrate. Notes saved under the old extension remain at `globalStorage/caspiantools.caspian-prompt/prompts/`; the new extension starts with an empty library at `globalStorage/caspiantools.caspian-notes/notes/`.

## [0.3.2] - 2026-04-25

### Fixed
- New-note editor would not close (X / Cancel / Esc / backdrop click). Real cause: `.backdrop { display: flex }` had higher specificity than the user-agent `[hidden] { display: none }` rule, so toggling the `hidden` attribute did nothing visually. Added an explicit `.backdrop[hidden] { display: none }` rule. (Bug existed since 0.1.0.)

## [0.3.1] - 2026-04-25

### Fixed
- New-note editor could not be closed (X / Cancel / Esc / backdrop click all silently did nothing). The view-toggle listener registration in 0.3.0 ran before the editor's listeners; if the toggle DOM elements were unavailable for any reason, an exception aborted the rest of setup. Listener registration is now null-safe via optional chaining, and `applyViewMode()` runs after all listeners are wired so it can never block setup.

## [0.3.0] - 2026-04-25

### Added
- **Grid / List view toggle** (Google Keep-style) in the toolbar. Two icon buttons beside the search box switch between the masonry grid and a compact list. The choice is persisted per webview via `vscode.setState` so it survives panel close/reopen.
- **List view** stacks cards as full-width rows: title (with body hidden) on the first row, tags on the second row, action buttons always visible on the right.

## [0.2.3] - 2026-04-24

### Fixed
- **Every command failed with `command '…' not found` because `.vscodeignore` had `node_modules/**`, which stripped the runtime `gray-matter` dependency from the packaged VSIX.** `out/promptStore.js` then failed `require('gray-matter')` on load, preventing `activate()` from ever running. Removed the blanket `node_modules/**` ignore; `vsce` automatically excludes devDependencies based on `package.json`, so only the runtime dependency closure ships.

## [0.2.2] - 2026-04-24

### Fixed
- Commands could fail to register (`command 'caspianPrompt.open' not found`) if the global storage directory couldn't be created during `activate()`. `activate` is now synchronous and registers commands immediately; directory creation is deferred to the first note write.

## [0.2.1] - 2026-04-24

### Changed
- Activity-bar icon now uses `media/favicon.svg` (the user-supplied brand mark).

## [0.2.0] - 2026-04-24

### Added
- **Activity-bar icon + sidebar tree view.** A new container in the activity bar hosts a tree view listing every note.
- View-title buttons: **New** ($(add)), **Open full library** ($(preview)), **Refresh** ($(refresh)).
- Right-click context menu on each tree item: **Copy**, **Insert at Cursor**, **Edit**, **Send to Chat**, **Delete**. Inline copy button on hover.
- Tree items respect the configured default card action when clicked.
- Welcome view shown when the library is empty, with quick links to create or open the full library.
- `refresh` command.
- `NotePanel.createOrShow` now accepts `{ editId }` so the **Edit** action on a tree item opens the full panel and immediately focuses the editor on that note.

### Changed
- `package.json` no longer declares explicit `activationEvents` — VS Code auto-generates them from command / view contributions in 1.74+.

## [0.1.0] - 2026-04-24

### Added
- Initial release (under the prior name "Caspian Prompt"; renamed to "Caspian Notes" in 0.4.0).
- Webview-based masonry grid (`open` command).
- CRUD editor modal — title, comma-separated tags, body.
- Markdown-with-frontmatter storage in `context.globalStorageUri`.
- Tag chip row with AND-combined filtering and live counts.
- Substring search across title, body, and tags.
- Four card actions: copy to clipboard, insert at cursor, edit, send to chat.
- Keyboard shortcuts inside the panel: `/` focus search, `Ctrl/Cmd+N` new, `Ctrl/Cmd+Enter` save, `Esc` close.

### Security notes
- Webview uses a strict CSP with per-load nonce; scripts are served only from the extension's `media/` folder via `localResourceRoots`.
- Extension makes no network requests — notes never leave your machine unless you configure `chatCommand` to forward them to another extension.
