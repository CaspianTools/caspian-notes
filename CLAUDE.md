# Caspian Notes — Claude Code Instructions

## Global Rules

- **Do NOT include `Co-Authored-By` lines in commit messages.** Never add co-author trailers for Claude or any AI assistant.
- **After every task, complete ALL post-task steps.** Every code change requires:
  1. **Version bump** — increment `package.json` version, update `CHANGELOG.md`, run `npm install` to sync lock file.
  2. **Documentation updates** — update all affected docs: `README.md`, `ARCHITECTURE.md`, `BUILD.md`, `SETUP_GUIDE.md`, `QUICKSTART.md`, `START_HERE.md`, `THREAT_MODEL.md`, and `package.json` description.
  3. **Build VSIX** — run `vsce package` to produce a new `.vsix` with the incremented version number. Confirm it packages without errors.
  4. **Commit** — stage all changed files and commit with a descriptive message following the Pre-Commit Checklist below (lint, compile, review, tag, push, release, Public-Assets release note).
  5. **Notify the user** — always tell the user the new version number and confirm the VSIX was built successfully. Never silently skip this.
  Never skip these steps. They apply to every task, no matter how small. If you forget any step, go back and complete it before moving on.

## Pre-Commit Checklist

Before every `git commit`, follow these steps **in order**. Do not skip any step. If a step fails, fix the issue and re-run from that step before continuing.

### 1. Lint
```
npm run lint
```
Fix all linting errors. Never use `--no-verify` to bypass lint failures.

### 2. Compile
```
npm run compile
```
Fix all TypeScript compilation errors before proceeding.

### 2a. Test
```
npm test
```
All vitest suites must pass.

### 2b. Audit
```
npm run audit
```
Production dependencies only (`--audit-level=high --omit=dev`). **This step is not optional** — `ci.yml` runs it on every push, so skipping it locally means discovering the failure only after `main` has already gone red. Fix findings with a targeted `overrides` entry in `package.json` rather than a blanket `npm audit fix`, which also rewrites dev-tree packages CI does not gate on (including the `@vscode/vsce` transitives that build the VSIX). Dev-only findings are accepted risk — see the 1.3.4 CHANGELOG notes.

### 3. Review Changed Files
Review all staged and modified files for:
- Accidental debug code (`console.log`, `debugger`, leftover `TODO`/`FIXME` comments)
- Hardcoded secrets, credentials, or API keys
- Unused imports or dead code introduced by the changes

If any issues are found, fix them before proceeding.

### 4. Bump Version
Increment the version number for every commit:

1. **`package.json`** — bump the `version` field (patch by default; minor for new features, major for breaking changes).
2. **`CHANGELOG.md`** — add a new `## [X.Y.Z] - YYYY-MM-DD` heading above the previous version.
3. Run `npm install` to sync `package-lock.json` with the new version.

### 5. Update Documentation
Update **all** documentation affected by the changes:

1. **CHANGELOG.md** — add entries under the current version heading using the existing format (`### Added`, `### Changed`, `### Fixed`).
2. **Review and update** any of these docs if the changes affect their content:
   - `README.md` — user-facing extension documentation / marketplace listing
   - `ARCHITECTURE.md` — system design and component descriptions
   - `BUILD.md` — build and development instructions
   - `SETUP_GUIDE.md` — deployment and configuration guide
   - `QUICKSTART.md` — quickstart guide
   - `START_HERE.md` — documentation index
   - `THREAT_MODEL.md` — update if the change affects the attack surface or adds a new trust boundary
3. **package.json** `description` field — update if the extension's capabilities changed.

### 6. Verify Packaging
```
vsce package
```
Confirm the extension packages into a `.vsix` without errors. Keep the `.vsix` file locally — it is needed for marketplace submission. It is already gitignored (`*.vsix`) so it will not be committed.

### 7. Commit
Create the commit with a descriptive message in imperative mood (e.g., "Add send-to-chat fallback" not "Added send-to-chat fallback"). Do **not** include `Co-Authored-By` trailers.

### 8. Tag
Create an annotated git tag for the new version:
```bash
git tag -a vX.Y.Z -m "vX.Y.Z — <short summary>"
```

### 9. Push
Push the commit and tag to the remote:
```bash
git push origin main --tags
```

### 10. Create GitHub Release
Create a GitHub Release with the `.vsix` attached:
```bash
gh release create vX.Y.Z caspian-notes-X.Y.Z.vsix \
  --title "vX.Y.Z — <short summary>" \
  --notes "<changelog entries for this version>"
```

### 11. Publish the update in Public-Assets
Every release gets its own Markdown release note in the public **[`CaspianTools/Public-Assets`](https://github.com/CaspianTools/Public-Assets)** repo, in its `caspian-notes/` folder. caspiantools.com reads that repo to build the project page's "Updates" section and the RSS / JSON feeds, so pushing the file is the whole publishing step. **Do not post to GitHub Discussions — that flow ended on 2026-10-01; existing Discussions stay but nothing new goes there.**

The local clone is `../Public-Assets` (`C:\Users\user\GitHub\Public-Assets`). If it's missing, run `gh repo clone CaspianTools/Public-Assets ../Public-Assets`. Always `git pull` before you write.

**Where it goes:**
```
Public-Assets/caspian-notes/release-notes/
├── README.md            ← index, newest first: add this release's row at the TOP of the table
└── <major>.<minor>/     ← e.g. 1.4/  (create it for the first release of a new minor line)
    └── <X.Y.Z>.md       ← e.g. 1.4.9.md: bare version, no "v" prefix
```
The first time you write a release note, create `release-notes/README.md` modelled on [`caspian-taskmaster/release-notes/README.md`](https://github.com/CaspianTools/Public-Assets/blob/main/caspian-taskmaster/release-notes/README.md): a `# Caspian Notes release notes` heading, one line saying the full history is in `CHANGELOG.md`, then a `| Version | Date | Headline |` table with rows like `| [X.Y.Z](<major>.<minor>/X.Y.Z.md) | YYYY-MM-DD | <headline> |`.

**How to write it.** Copy `Public-Assets/_templates/release-note.md` and fill in every field. Use [`caspian-taskmaster/release-notes/1.31/1.31.2.md`](https://github.com/CaspianTools/Public-Assets/blob/main/caspian-taskmaster/release-notes/1.31/1.31.2.md) as the worked example.
- **Front matter:** `product: Caspian Notes`, `version` (`X.Y.Z`), `date` (same as the CHANGELOG heading, `YYYY-MM-DD`), `type` (`patch` / `minor` / `major`) and `headline`.
- **Top section (social-media-ready):** the owner copy-pastes everything above `## Full changes` straight to X, LinkedIn and similar sites, so keep it short and punchy.
  - `# Caspian Notes X.Y.Z: <headline>`. The headline is action-oriented, attention-grabbing and user-facing, under 100 characters (e.g., "Caspian Notes adds send-to-chat fallback").
  - A 1–3 sentence intro.
  - 2–4 bullets of what's new. Use emojis sparingly.
  - A one-line value proposition.
  - **Always include the Marketplace link:** https://marketplace.visualstudio.com/items?itemName=CaspianTools.caspian-notes
- **`## Full changes`:** this version's CHANGELOG section, verbatim. Never link into a private repo; public readers get a 404.
- **`## Get it`:** the Marketplace link above and Open VSX (https://open-vsx.org/extension/CaspianTools/caspian-notes).

For a one-off post that isn't tied to a version (a notice, a deprecation), use `Public-Assets/_templates/update.md` instead, at `caspian-notes/updates/<YYYY>/<YYYY-MM-DD>-<slug>.md`, with front matter `product`, `title`, `date`, `type` (`feature` / `fix` / `release` / `notice`), `social` (`false` = feed and website only) and `draft` (`true` = committed but not published). Quote the `title` if it contains ` #`. The body is two to five plain sentences for users, not developers.

**Then validate, commit and push Public-Assets** (commit only your new file(s), never `index.json`; a workflow regenerates it):
```bash
cd ../Public-Assets
git pull
node scripts/build-index.mjs --validate
git add caspian-notes/release-notes
git commit -m "Add caspian-notes X.Y.Z release note"
git push origin main
```
Tell the user the note's URL: `https://github.com/CaspianTools/Public-Assets/blob/main/caspian-notes/release-notes/<major>.<minor>/<X.Y.Z>.md` (or the `updates/` path). It appears on https://caspiantools.com/projects/caspian-notes and in https://caspiantools.com/feeds/caspian-notes.xml after the next daily site rebuild (05:00 UTC).

**Never rename or move a published file.** Its path is its permanent ID in the feeds, so a renamed file shows up as a new post.

## Worktrees & the ship rule

Claude Code can run parallel sessions in isolated **git worktrees** (`claude --worktree <name>`, or ask it to "work in a worktree" → the `EnterWorktree` tool). A worktree lives under `.claude/worktrees/<name>/` on branch `worktree-<name>`, branched **fresh from `origin/main`** by default (set `worktree.baseRef: "head"` in `.claude/settings.json` to carry local HEAD instead). `.claude/worktrees/` is gitignored and **`.worktreeinclude`** copies any local secrets into new worktrees — see those two files. `node_modules` and build artifacts are *not* copied: run `npm install` then `npm run compile` in each new worktree.

**How this repo ships:** there is **no auto-deploy on push to `main`** — [`ci.yml`](.github/workflows/ci.yml) runs only lint / compile / test / audit on push and PRs. The actual release fires from [`release.yml`](.github/workflows/release.yml) on a **git tag push** (`v*`): it packages the `.vsix` and creates a GitHub Release, and (when `VSCE_PAT` / `OVSX_PAT` are wired) publishes to the VS Code Marketplace / Open VSX. So the shippable moment is **tag + push tag**, not a branch push. A worktree sits on `worktree-<name>`, so a "commit + push" *inside* a worktree pushes a feature branch — it runs CI but ships nothing. The standing post-task flow (see the Pre-Commit Checklist: bump → package → commit → tag → push → release → Public-Assets release note) **adapts inside a worktree** — do NOT blindly tag/push a release from one:

1. **Commit, pause before landing.** Auto-commit finished work on the `worktree-<name>` branch, then **stop and report**. Never merge to `main`, and never create/push the `vX.Y.Z` tag (the step that releases/publishes), without the owner's explicit go-ahead. *(On `main` — the normal solo flow — the Pre-Commit Checklist is unchanged: bump, package, commit, tag, push, release, Public-Assets release note.)*
2. **Serialize landings — one at a time.** Never land two worktrees to `main` in parallel. If another worktree/session is still in flight, wait for it to land first. "Wait" means: at land time `git fetch` and rebase onto whatever `origin/main` now is; if the owner says another is mid-flight, hold until told it's done.
3. **Resolve conflicts in the worktree, never on `main`.** At land time: `git fetch origin` → **rebase `worktree-<name>` onto the latest `origin/main`** → resolve every conflict *there*, so `main` only ever receives an already-merged, clean tree.
4. **Finalize the version bump last.** The version — `package.json` `version`, the `CHANGELOG.md` `## [X.Y.Z]` heading, and `package-lock.json` (via `npm install`) — plus the eventual `vX.Y.Z` tag is the *guaranteed* collision between two shippable worktrees. Don't fix the number until after the rebase — take *current-main + 1*, then update those files and any affected docs (README / ARCHITECTURE / BUILD / SETUP_GUIDE / QUICKSTART / START_HERE / THREAT_MODEL).
5. **Re-verify + rebuild after resolving.** Re-run the Pre-Commit Checklist gates against the rebased tree — `npm run lint`, `npm run compile`, `npm test` (vitest), then `npx @vscode/vsce package` to confirm the `.vsix` still builds cleanly. A conflict resolution that isn't re-verified is a bug waiting to ship.
6. **Only then ship.** Fast-forward `main` to the clean, verified branch → `git push origin main` (CI runs) → then create the annotated tag `git tag -a vX.Y.Z` and `git push origin main --tags` to trigger the Release workflow → finish with the GitHub Release + Public-Assets release note chores (step 11). **Never tag/push a conflicted or failing tree.**

For solo, single-stream work that ships immediately, **skip worktrees and work on `main` directly** — the Pre-Commit Checklist needs no adaptation. Reserve worktrees for genuine parallelism (two tasks at once) or experiments you may not ship.
