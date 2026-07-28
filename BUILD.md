# Caspian Notes — Build & Development

## Prerequisites

- Node.js 18+ (20 recommended)
- npm 9+
- VS Code 1.85+
- (for publishing) `vsce`, `ovsx` installed globally

## Setup

```bash
git clone https://github.com/CaspianTools/caspian-notes.git
cd caspian-notes
npm install
npm run compile
```

## Run in debug

Open the repo in VS Code and press **F5** to launch an Extension Development Host. Run `Caspian Notes: Open Notes Library` from the command palette in the new window.

## Watch mode

```bash
npm run watch
```

Keeps `tsc` running on file change. Reload the dev host window (`Ctrl/Cmd + R` inside the dev host) to pick up changes.

## Lint

```bash
npm run lint
```

## Test

```bash
npm test          # vitest run — single pass
npm run test:watch
```

## Audit

```bash
npm run audit     # npm audit --audit-level=high --omit=dev
```

Production dependencies only. Dev-only findings are excluded because they never ship inside the VSIX — see the note at the end of the 1.3.4 entry in [CHANGELOG.md](CHANGELOG.md).

## Package

```bash
vsce package
```

Produces `caspian-notes-<version>.vsix`. The file is gitignored.

## Publish

```bash
# VS Code Marketplace
vsce login CaspianTools
vsce publish

# Open VSX
ovsx publish -p "$OVSX_TOKEN"
```

## Project structure

```
caspian-notes/
├── src/
│   ├── extension.ts        # activate / command registration
│   ├── notePanel.ts        # webview panel singleton
│   ├── noteStore.ts        # fs CRUD + frontmatter (+ .test.ts)
│   ├── noteTreeProvider.ts # sidebar tree view + sync markers
│   ├── noteActions.ts      # copy / insert / send-to-chat
│   ├── chatCommand.ts      # Claude Code / chat integration
│   ├── templates.ts        # note templates (+ .test.ts)
│   ├── localId.ts          # stable per-note id for cloud doc keys
│   ├── timeAgo.ts          # relative-time strings for tooltips
│   ├── types.ts            # Note + message protocol
│   └── cloud/              # optional two-way sync (1.4.0+)
│       ├── auth.ts         #   custom token → refresh token in SecretStorage
│       ├── pair.ts         #   vscode:// pairing URI handler
│       ├── sync.ts         #   outbound/inbound 15s loops
│       ├── firestore.ts    #   REST client (runQuery / setDoc)
│       ├── writerTag.ts    #   EXTENSION-SYNC-CONTRACT loop prevention
│       ├── uploadAll.ts    #   bulk bootstrap push
│       ├── assignProject.ts#   assign note → project
│       └── projectPicker.ts#   quick-pick over workspace projects
├── media/
│   ├── favicon.svg         # activity-bar glyph
│   ├── main.js             # webview client
│   ├── styles.css          # masonry + editor styles
│   └── vendor/             # copied in by copy-vendor (gitignored)
├── scripts/
│   └── copy-vendor.cjs     # runs as part of `npm run compile`
├── out/                    # tsc output (gitignored)
├── icon.png
├── package.json
├── tsconfig.json
└── .eslintrc.json
```

## Worktrees

Parallel Claude Code sessions can run in isolated git worktrees under `.claude/worktrees/`. `node_modules` and build output are **not** copied in — run `npm install` then `npm run compile` inside each new worktree. See the "Worktrees & the ship rule" section of [CLAUDE.md](CLAUDE.md) for how the release flow changes inside one.

## Adding features

- **New card action** — extend `CardAction` in `src/types.ts`, handle it in `NotePanel.handleAction`, and add a button in `media/main.js` `renderCard`.
- **New setting** — add it under `contributes.configuration.properties` in `package.json` and read it with `vscode.workspace.getConfiguration('caspianNotes')`.
