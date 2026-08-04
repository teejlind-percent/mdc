# Building an mdc Mini App

How to build a trusted HTML mini app that reads and writes workspace files through mdc's `window.mdc` bridge. Markdown (or any text file) stays the source of truth; the app is a richer editor over it.

## What a mini app is

A single `.html` file that mdc runs inside a sandboxed iframe with scripts enabled. It cannot touch the filesystem directly — every read/write goes through `window.mdc`, which mdc mediates and permission-checks. Untrusted HTML stays view-only (no scripts); an app only runs once the user explicitly trusts it.

A packaged example ships in the box: `mdc example kanban` copies a markdown-backed Kanban board into the workspace's `apps/` folder. Its board files live beside the app in `apps/kanban/boards/<board>.md`, and the example includes `boards/main.md` with empty Backlog, In progress, and Done columns so a fresh copy opens as a working board. Read its source alongside this guide — it's a working instance of everything below.

## The one-file recipe

Put the app and the data it owns in their own folder:

    apps/<name>/
      <name>.html      ← the app
      <name>.md        ← the data it reads/writes

Declare the app in an HTML comment at the top of the `.html`. For an app that only touches its own folder, the manifest is just a name:

    <!--
    mdc-app:
      name: My App
    -->

- `name` is required — it's what the trust prompt and toolbar show.
- Paths inside the app's own folder are **granted by default** — an own-folder app needs no `permissions` block at all.

To reach *beyond* its own folder, an app declares explicit read/write scopes:

    <!--
    mdc-app:
      name: My App
      permissions:
        read:
          - tasks
          - projects
        write:
          - tasks
    -->

- `permissions.read` / `permissions.write` are root-relative paths (a file or a folder).
- `write` is always a subset of `read`: you can't write what you can't read.
- List only paths that reach beyond the app's own folder; listing an in-folder path is harmless but redundant.

## The `window.mdc` API

    // Reading
    window.mdc.readText(path)                     → { path, content, version }
    window.mdc.listFiles(path, opts?)             → { path, entries: [{ path, type }] }
    window.mdc.readFrontmatter(path, opts?)       → { path, entries: [{ path, frontmatter }] }

    // Writing
    window.mdc.writeText(path, content, baseVersion?) → { path, saved: true, version }
    window.mdc.deleteFile(path)                   → { path, deleted: boolean }

    // App state (persistence + reactivity)
    window.mdc.getState()                         → <your blob> | null
    window.mdc.setState(blob)                     → { saved: true }
    window.mdc.watch(callback)                    → unsubscribe()

    // Environment / navigation
    window.mdc.getAppInfo()                       → { appPath, rootName, name, permissions, trusted }
    window.mdc.openFile(path)                     → { delivered: true }
    window.mdc.openUrl(url)                       → { opened: true }

**Applies to every call:** available only inside a trusted app frame; all methods return Promises (except `watch`, which returns its unsubscribe function synchronously); every call is permission-checked against the manifest scope on the server. An out-of-scope, untrusted, denied, or conflicting call **rejects** — wrap calls in try/catch and surface the error to the user, never assume success.

### `readText(path)` → `{ path, content, version }`

Read a file the app is scoped to read. `content` is the file text; `version` is a token for that content — hold it to do a [conflict-safe write](#conflict-safe-writes-read-modify-write).

### `listFiles(path, opts?)` → `{ path, entries: [{ path, type }] }`

Lists one directory level by default (files and subfolders, like a file explorer). Pass `{ recursive: true }` to walk the whole subtree instead — it returns **files only**, every file under `path` the app may read, with denied/system dirs (`.git`, `node_modules`) skipped. Discover a whole granted folder in one call:

    const { entries } = await window.mdc.listFiles("tasks", { recursive: true });
    // entries: [{ path: "tasks/a.md", type: "file" }, { path: "tasks/sub/b.md", type: "file" }, …]

### `readFrontmatter(path, opts?)` → `{ path, entries: [{ path, frontmatter }] }`

Returns the frontmatter block of every scoped file under `path` in **one call** — the batch answer to "list the files, then read each one just for its frontmatter." Same `path` + `{ recursive: true }` shape as `listFiles`, same scope-checking; each entry carries the **raw** frontmatter text (between the leading `---` fences), or `null` for a file with none. Parse it with your own frontmatter reader. Prefer this over `listFiles` + a `readText` per file whenever an aggregating app only needs frontmatter to build its view — it turns N round-trips into one:

    const { entries } = await window.mdc.readFrontmatter("tasks", { recursive: true });
    // entries: [{ path: "tasks/a.md", frontmatter: "status: wip\ntags: [ui]" }, { path: "tasks/plain.md", frontmatter: null }, …]

### `writeText(path, content, baseVersion?)` → `{ path, saved: true, version }`

Write a file the app is scoped to write. Returns a fresh `version` for the just-written content (ready to reuse as the next `baseVersion` without re-reading). Two write behaviours + a cross-folder confirm, below.

#### Conflict-safe writes (read-modify-write)

For a **read-modify-write** — read a file, change part of it, write it back — pass the `version` from your read as `baseVersion`. The write then succeeds only if the file still matches; if anything edited it in between (an external editor, the user, another app), it's **rejected** instead of silently clobbering that edit:

    const { content, version } = await window.mdc.readText("tasks/a.md");
    const next = edit(content);
    try {
      await window.mdc.writeText("tasks/a.md", next, version);   // conflict-checked
    } catch (e) {
      // "changed underneath you — reload": re-read and re-apply, then retry
    }

The error is your cue to re-read (you get a fresh `version`), re-apply your change to the new content, and write again. Omit `baseVersion` for a **blind write** — a fire-and-forget save, or creating a brand-new file — where there's no prior version to protect. (Passing a `baseVersion` for a file that no longer exists is also a conflict: the base you read was deleted underneath you. To create a new file, pass no `baseVersion`.)

#### Writing outside your own folder asks the user first

Writing **inside the app's own folder** is silent — that's the app's home. But the **first time** an app writes a file *outside* its folder (a path granted by a manifest `write` scope), mdc shows a confirmation naming the file, with **Allow once** / **Always allow** / **Deny** — a moment-of-action checkpoint on top of the up-front trust grant. So a cross-folder `writeText` can be **declined**: the promise rejects like any failed write, so handle it the same way. "Always allow" suppresses the prompt for the rest of the browser session (re-asks in a fresh one). You do nothing special to trigger this — just write, and be ready for the call to reject.

### `deleteFile(path)` → `{ path, deleted: boolean }`

Delete a file the app is scoped to write — deleting is a write, so it needs `write` scope and a cross-folder delete goes through the same first-time confirm (own-folder deletes are silent). It removes the file and its comment sidecar together, and **no-op-succeeds** if the file is already gone (`deleted: false`). A denied or out-of-scope call rejects — wrap and surface it.

### `getState()` / `setState(blob)`

Persist a small, opaque per-app blob (any JSON-serializable value — UI selection, scroll position, a draft) that mdc holds for you. This is the **only** way an app keeps state across remounts: a trusted app's frame is opaque-origin (no `localStorage`/`sessionStorage`), and mdc unmounts the app when you switch away from its tab and remounts it on return. Restore on boot, save on change:

    const saved = await window.mdc.getState();      // your last blob, or null
    if (saved) restoreUI(saved);
    // …later, on any change:
    await window.mdc.setState({ selected: id, scroll: y });

The blob survives the tab-switch remount and in-session reloads (⌘R), but is **cleared when the browser session ends** — treat it as session-scoped UI state, not a database (the markdown files are your source of truth; persist real data there with `writeText`). Namespaced per app (apps can't read each other's blob); capped at ~1 MB.

### `watch(callback)` → `unsubscribe()`

Keeps an app live: register a callback and mdc fires it whenever **any file the app may read** changes on disk (added, edited, or deleted), so an aggregating app reflects workspace changes without a manual reopen. It's coarse — the callback takes no arguments; re-run your data load on each fire:

    const stop = window.mdc.watch(() => load());   // load() re-reads + re-renders
    // …later, if you ever need to stop: stop();

Bursts (e.g. a multi-file save) collapse into a single fire. The subscription tears down automatically on remount, so you don't have to unsubscribe. A manual refresh button is still worthwhile for a deliberate reload, but `watch` removes the *need* to press it.

### `getAppInfo()` → `{ appPath, rootName, name, permissions, trusted }`

Returns the app's own manifest-declared identity + scopes + trust state — for an app that wants to show its own name/permissions or branch on what it's allowed to do. `appPath` is the app's own folder, so an app can derive the paths it owns rather than hard-coding them, and works wherever it's copied.

### `openFile(path)` → `{ delivered: true }`

Asks mdc to open a file as a workspace tab — switches to the file's tab if already open, else adds a new tab. Navigational, not file access (it grants nothing the bridge doesn't already): use it to let an app link out to the workspace files it surfaces. The path must be an openable file in the index (doc, image, html, or PDF) or the call rejects.

### `openUrl(url)` → `{ opened: true }`

Asks mdc to open an external link in a new browser tab. **This is the only way an app can link out** — the sandbox withholds popup and top-navigation permission, so a plain `<a href="https://…" target="_blank">` inside an app does nothing. Wire links to `openUrl` instead:

    document.querySelector("#docs-link").addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await window.mdc.openUrl("https://example.com/docs");
      } catch (err) {
        showInlineMessage(err.message);   // your UI — mdc shows nothing itself
      }
    });

`url` must be **absolute** and use an allowed scheme: `https:`, `http:`, or `mailto:`. Everything else — `javascript:`, `data:`, `blob:`, `file:`, and relative paths — rejects without opening anything. The allowlist is deny-by-default and is the only gate on outbound navigation, so it stays deliberately narrow.

There is no prompt: the user already trusted this exact version of your app, and a confirmation on every link would make ordinary links feel broken.

**Handle the rejection.** mdc draws no UI when a URL is refused — it blocks the navigation and rejects the promise, nothing more. If your app ignores the error, the click is a silent no-op and the user is left guessing, which matters most when the URL came from *their* data (a link in a note, a value in a config) rather than from your source. Catch it and say something.

One caveat outside mdc's control: the tab is opened by mdc on your behalf, not by a click the browser attributes to the user, so a strict popup blocker can swallow it. The promise still resolves — mdc can't reliably tell an opened tab from a blocked one — so don't treat resolution as proof the user saw the page.

## Sandbox limits — read this before you build

The app runs in `sandbox="allow-scripts"`: scripts run, but **every other browser capability is off by design.** In particular:

- **No `prompt()`, `confirm()`, `alert()`** — modals are not enabled. Use inline UI (an editable field, an inline confirm row) instead. The Kanban example does exactly this.
- **No parent/app access** — the frame is opaque-origin. The app can't reach mdc's DOM or call its API except through `window.mdc`. This is the security boundary.
- **No `localStorage` / `sessionStorage`** — the opaque origin has no web storage; accessing it directly throws. mdc also unmounts the app when you leave its tab and re-runs it from scratch on return, so in-memory state is lost too. So: re-read your data from disk on load, and to *remember* UI state (a selection, a setting) across remounts use `window.mdc.getState()`/`setState()` (above) — the parent-mediated store — not browser storage.
- **No popups, forms posting out, top-navigation, etc.** — not enabled. So a plain `<a target="_blank">` is inert; to link out, call `openUrl` (above), which mdc performs for you after checking the scheme.
- **mdc's ⌘-shortcuts don't fire while focus is in the app** — keyboard events don't bubble out of the sandbox. Click into the app to use it, out to use mdc.

Build the app to live within these limits: do all interaction inline, using only `window.mdc` for file access. If your app genuinely needs a capability the bridge doesn't offer (reading another file type, an mdc-native dialog), that's a request to extend `window.mdc` — raise it with the mdc maintainers rather than trying to widen the sandbox, which is deliberately locked down.

## Design conventions

A mini app should look like it belongs beside the others — **reuse the shared mini-app design system, don't invent styling.** Apps read as part of mdc when they match it, and jarring when they don't. (Mini apps have their own palette, below — mdc's *product chrome* has a separate design system, [DESIGN.md](../DESIGN.md); work on the product frontend follows that one.)

- **Reuse the shared `:root` palette.** Apps share one token set — `--bg`, `--col`, `--border`, `--border-mid`, `--text`, `--muted`, `--wash` (the hover fill), plus status tints (`--wip-tint/-text`, `--done-tint/-text`, `--todo-*`, `--blocked-*`) when an app shows status. Copy it from the Kanban example rather than hand-picking new colors.
- **Match the example's chrome.** The Kanban example is the reference for header layout, the card/row look, uppercase muted group labels, inline editors + inline confirm rows, and the `⋯` action menu. Follow those patterns rather than a fresh design.
- **A token has a meaning — don't repurpose it.** The status tints mean *status* (`--wip-tint` reads as "WIP"). For a neutral cue (a hover, a drop target, a selected row) use `--wash` + `--border-mid`, not a status color.
- **Match the existing element vocabulary, don't add lone ornaments.** If the surrounding UI is text-only, a new entry stays text-only — don't add a lone icon/emoji to one item. Consistency beats decorating one element.
- **Light-only.** Apps don't read mdc's dark mode; build light-only, as the Kanban example does.

When unsure, open the Kanban example and copy its approach — the goal is that a new app reads as belonging, needing no redesign at build time.

## Trust

- HTML is untrusted by default (view-only, no scripts).
- The user trusts an app explicitly via mdc's trust prompt, which shows the app's declared scopes before it runs.
- Trust is stored per-workspace, keyed by the file's content hash. **Editing the app changes its hash → it re-prompts.** So "trusted" always means "this exact version."
- Trust does not travel between workspaces.
