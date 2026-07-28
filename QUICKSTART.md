# Caspian Notes — Quickstart

## 5-minute setup

```bash
git clone https://github.com/CaspianTools/caspian-notes.git
cd caspian-notes
npm install
npm run compile
```

Open the folder in VS Code and press **F5**. In the Extension Development Host window, run `Caspian Notes: Open Notes Library` from the command palette.

## First note

1. Click **+ New**.
2. Title: `Review for security`
3. Tags: `review, security`
4. Body:
   ```
   Review the following code for common security issues (injection, auth, crypto, input validation). Be concise.
   ```
5. **Save**.

The card appears in the grid. Click it to copy the body to your clipboard. Hover it to reveal per-action buttons (Copy, Insert, Chat, Edit).

## Add more, then try filtering

Add a few more notes with different tags. The chip row below the search bar lists every tag with a count — click chips to filter (AND logic). Type in the search box for an instant substring match across title, body, and tags.

## Next

- `README.md` — full feature list and settings reference.
- `BUILD.md` — watch mode, packaging, publishing.
- `ARCHITECTURE.md` — how the webview talks to the extension host.
