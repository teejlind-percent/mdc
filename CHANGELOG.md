# Changelog

All notable user-facing changes to mdc. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Fixed
- Open tabs now show the same per-file-type icon as the file tree, so an image, HTML file, PDF, or drawing is recognisable in the tabs strip instead of every tab sharing the markdown icon.

## [0.7.0] - 2026-07-24

### Added
- A ⋮ Document actions menu at the end of the doc toolbar, on every file type, with **Copy filename** and **Copy path** (the absolute path, the same form the handoff prompt uses).
- **Copy contents** in the ⋮ menu for markdown, copying the raw text (frontmatter included) that matches what's on screen — the live edit buffer before autosave, the editable side of a conflict review, or a previewed suggestion. The toast notes `· unsaved` until that exact text is on disk, and `· reload pending` when you're looking at a snapshot the file has since moved past.
- **Copy contents** also covers drawings and HTML files. A drawing copies the live canvas, including a change still waiting for autosave, and a drawing whose contents can't be rendered still copies its raw text. HTML copies the source behind the page you're looking at, whether it's shown as plain HTML or running as a trusted app. Images and PDFs have no text to copy, so the item isn't offered for them.
- The same copy actions on file-tree right-click, acting on the row you clicked rather than the open file: a file offers **Copy filename**, **Copy path**, and — when it has text — **Copy contents**; a folder offers **Copy path**. Copying the open file picks up its live version and `· unsaved` / `· reload pending` status just as the ⋮ menu does, while any other row is read from disk.

### Changed
- File-tree context menus now show familiar icons and separate creation actions from deletion.
- **End session…** has moved into the new ⋮ menu, so the toolbar carries one overflow menu instead of a second kebab that appeared only while an agent was watching.

### Fixed
- Workspace names stay visible in browser tabs and standalone app windows when the served root path has a trailing slash.
- Images, PDFs, HTML, and drawings no longer show a comments sidebar that cannot accept anchored comments.

## [0.6.2] - 2026-07-20

### Fixed
- The workspace name is now in the page the server sends, so a remote workspace no longer opens showing "mdc" and renaming itself once the file list loads.

## [0.6.1] - 2026-07-20

### Changed
- The page title now matches the installed app's name ("mdc — workspace"), so the standalone window's title bar shows it once instead of "mdc — workspace - mdc".

## [0.6.0] - 2026-07-20

### Added
- Opt in to launching a workspace in a chromeless Chrome app window with `mdc serve --app-window` or `app_window = true` in `.mdc.toml` (macOS with Chrome installed; falls back to a browser tab).
- Each workspace now installs as its own named app ("mdc — folder-name"): the web app manifest is generated per workspace, so multiple installed workspaces are distinguishable in the Dock.

## [0.5.0] - 2026-07-20

### Added
- Install mdc as a standalone app from the browser (Chrome's install icon, or Safari's File → Add to Dock) for a dedicated window and Dock icon without the URL bar.

## [0.4.0] - 2026-07-19

### Added
- Paste clipboard images or drag image files into an edited markdown doc to add them under a sibling `assets/` folder and insert their references.
- Open `.excalidraw` and `.excalidraw.json` files as interactive read-only drawings, with offline fonts, live reload, theme support, and workspace navigation.
- Edit drawings with the full Excalidraw toolset and conflict-safe autosave, then switch back to a read-only canvas.
- Create new drawings from the Files pane, with drawing-aware filename defaults and a ready-to-edit empty canvas.

## [0.3.0] - 2026-07-18

### Added
- Suggestion cards in view mode now pin a reversible in-document diff preview, with a stacked fallback when the proposed edit changes block structure.
- Pinned suggestion previews now include floating Accept, Reject, and Close actions for deciding changes in place.
- Large suggestion diffs now collapse to a line summary with a Preview in doc action, and clicking a suggestion mark opens its in-document preview.
- Suggestion cards in edit mode now pin an undoable inline merge chunk; accepting persists the edit, while rejecting or closing restores the buffer without autosaving the preview.

### Changed
- Rejecting a suggestion now leaves its thread open, passes the turn to the agent, and focuses an optional reason reply instead of closing the conversation.
- Conflict merge views now use the shared teal/violet diff colors for added and removed text.
- The Files pane now labels open tabs and the workspace tree, with tab close controls visible at rest.

### Fixed
- Comment highlights stay within horizontally scrolling code blocks at narrow document widths.
- Suggestions remain applicable when their display anchor is orphaned but the raw target is still current; the CLI warns when a default target contains Markdown syntax.
- The packaged Kanban example now opens with starter columns and stores its first board beside the app.
- Typing an empty bullet after a paragraph no longer makes the previous line appear as a heading in edit mode.

## [0.2.0] - 2026-07-11

### Added
- Settings now shows the running mdc version with a link to release notes.
- Suggestions: an agent can propose an exact edit (including a deletion) on any comment or reply; the thread card shows a word-level diff and the user accepts it into the doc — in rendered view or the editor, where it's a normal undoable edit — rejects it, or replies to refine. Decisions stay on the thread as Applied or Dismissed, a revised proposal supersedes the earlier one, and a suggestion whose target text has drifted orphans safely instead of mis-applying.

### Changed
- `mdc setup` now teaches agents to answer doc-change requests with suggestions — propose the exact edit, let the human decide — instead of editing docs directly or describing edits in prose.

### Fixed
- `mdc --version` now reports the installed version instead of a stale number.

## [0.1.1] - 2026-07-08

### Changed
- `mdc --help` now describes rendering, editing, and mini apps, not just margin review.

### Fixed
- Comments authored before you set your name stay styled as yours, not an agent's, after you rename yourself.

## [0.1.0]

Initial public release.
