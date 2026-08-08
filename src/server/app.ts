/**
 * The mdc server — Hono app + routes.
 *
 * Hosts the `/api/*` routes, the live-reload SSE stream, and the handoff
 * SSE/session endpoints, and serves the `static/` frontend. Everything is
 * read and written through the shared `mdc` core, so the sidecar format stays
 * identical across the CLI, the frontend, and any agent.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, posix, relative, sep } from "node:path";
import {
  VERSION,
  applySuggestion,
  appendEntry,
  appendEntries,
  buildEntries,
  countOpenThreads,
  deriveThreads,
  isEvent,
  newId,
  nowIso,
  readSidecar,
  topLevelComments,
  ValidationError,
  pruneIfEmpty,
  type Anchor,
  type Entry,
} from "../index.js";
import {
  buildDirIndex,
  buildDrawingIndex,
  buildHtmlIndex,
  buildImageIndex,
  buildIndex,
  buildPdfIndex,
  denyFrom,
  findOrphanSidecars,
  IMAGE_EXTS,
  isDrawingName,
  walkFiles,
} from "./walk.js";
import { HandoffRegistry } from "./handoff-state.js";
import { diffEdits, hunkBody, MAX_CAPTURED_HUNKS } from "../edit-capture.js";
import { parseManifest, ManifestError, type AppManifest } from "../apps/manifest.js";
import { canRead, canWrite, fileVersion } from "../apps/scope.js";
import { isTrusted, trustApp } from "../apps/trust.js";
import { planMove, planSummary } from "../move/plan.js";
import {
  HttpError,
  baseName,
  resolveFile,
  resolveDrawingFile,
  resolveHtmlFile,
  resolveImage,
  resolveImageFile,
  resolveIndexedHtml,
  resolveIndexedDrawing,
  resolveIndexedImage,
  resolveIndexedPdf,
  resolvePdfFile,
  resolveSidecarForDelete,
  resolveSidecarPath,
  resolveWithinRoot,
  sidecarPath,
} from "./paths.js";
import { RootWatcher } from "./watcher.js";

export interface ServerConfig {
  root: string;
  staticDir: string;
  denyRaw: string;
  user: string;
}

/** Per-server mutable index state, rebuilt on each index/dashboard hit. */
interface IndexState {
  index: Set<string>;
  drawingIndex: Set<string>;
  imageIndex: Set<string>;
  htmlIndex: Set<string>;
  pdfIndex: Set<string>;
}

const EMPTY_EXCALIDRAW_SCENE =
  '{"type":"excalidraw","version":2,"source":"mdc","elements":[],"appState":{},"files":{}}';
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

function rawFrontmatter(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const body = content.slice(4);
  const close = /\n---(?:\n|$)/.exec(body);
  if (!close) return null;
  return body.slice(0, close.index);
}

export function createApp(cfg: ServerConfig): {
  app: Hono;
  watcher: RootWatcher;
} {
  const deny = denyFrom(cfg.denyRaw);
  const state: IndexState = {
    index: buildIndex(cfg.root, deny),
    drawingIndex: buildDrawingIndex(cfg.root, deny),
    imageIndex: buildImageIndex(cfg.root, deny),
    htmlIndex: buildHtmlIndex(cfg.root, deny),
    pdfIndex: buildPdfIndex(cfg.root, deny),
  };
  const handoff = new HandoffRegistry();
  const watcher = new RootWatcher(cfg.root, deny);

  // Broadcaster for "open this file" commands (POST /api/open → every live SSE
  // connection). Separate from the file watcher: an open targets a file the tab
  // may not be watching yet, so it isn't filtered by the watched set.
  const openListeners = new Set<(rel: string) => void>();
  function broadcastOpen(rel: string): void {
    for (const l of openListeners) l(rel);
  }

  /** Rebuild the indexes (so newly added/removed files show up). */
  function rescan(): void {
    state.index = buildIndex(cfg.root, deny);
    state.drawingIndex = buildDrawingIndex(cfg.root, deny);
    state.imageIndex = buildImageIndex(cfg.root, deny);
    state.htmlIndex = buildHtmlIndex(cfg.root, deny);
    state.pdfIndex = buildPdfIndex(cfg.root, deny);
  }

  const app = new Hono();

  // Turn an HttpError into the matching HTTP response; rethrow the rest.
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ detail: err.message }, err.status as 400);
    const status = (err as Error & { status?: number }).status;
    if (status) return c.json({ detail: err.message }, status as 400);
    console.error(err);
    return c.json({ detail: "internal error" }, 500);
  });

  // The workspace's display name, shared by the page title and the web app
  // manifest. Both must match exactly: Chrome's standalone window drops the
  // app-name prefix only when the page title already starts with it.
  const workspaceTitle = `mdc — ${basename(cfg.root)}`;

  // --- index page (serves the built frontend's index.html) -----------------
  // The bundled app is otherwise self-contained (it reads the user from
  // /api/index, and Vite hashes asset filenames for cache-busting). The one
  // substitution: the workspace title, injected here so the first painted
  // frame already carries the installed app's name. Leaving it to the frontend
  // means a stale "mdc" title until /api/index answers — visible as a flicker
  // on a remote workspace, where that round-trip is slow.
  app.get("/", (c) => {
    const html = readFileSync(join(cfg.staticDir, "index.html"), "utf8");
    return c.html(html.replace("<title>mdc</title>", `<title>${escapeHtml(workspaceTitle)}</title>`));
  });

  // --- root-level statics (Vite copies web/public/* to the static root) -----
  // Favicon plus the icons the web app manifest points at, which let the
  // browser install mdc as a standalone app.
  const rootStatics: Record<string, string> = {
    "/favicon.svg": "image/svg+xml",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
    "/apple-touch-icon.png": "image/png",
  };
  for (const [path, contentType] of Object.entries(rootStatics)) {
    app.get(path, (c) => {
      try {
        const body = readFileSync(join(cfg.staticDir, path.slice(1)));
        return c.body(toBytes(body), 200, {
          "content-type": contentType,
          "cache-control": "public, max-age=86400",
        });
      } catch {
        throw new HttpError(404, "not found");
      }
    });
  }

  // --- web app manifest (generated, not static) ------------------------------
  // Named after the served root so each workspace installs as its own app
  // ("mdc — personal"), distinguishable in the Dock when several are installed.
  // Colors mirror web/index.html's theme-color metas.
  app.get("/manifest.webmanifest", (c) => {
    return c.body(
      JSON.stringify({
        name: workspaceTitle,
        short_name: basename(cfg.root),
        description: "Local markdown workspace where humans and coding agents review docs together",
        start_url: "/",
        display: "standalone",
        background_color: "#f7f4ef",
        theme_color: "#f7f4ef",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      }),
      200,
      {
        "content-type": "application/manifest+json",
        "cache-control": "public, max-age=86400",
      },
    );
  });

  // --- file index for the file tree -------------------------------------------
  app.get("/api/index", (c) => {
    rescan();
    const files = [...state.index].sort().map((rel) => ({
      path: rel,
      openThreadCount: countOpenThreads(join(cfg.root, rel) + ".comments.jsonl", cfg.user),
    }));
    // Directories are sent alongside files so the file tree can render folders that
    // hold no .md yet (e.g. a just-created empty folder).
    const dirs = [...buildDirIndex(cfg.root, deny)].sort();
    // Drawings, images, HTML, and PDF files travel separate channels from `files`: they're
    // openable (tree, tabs, jump) but not commentable, so they must NOT join the
    // path set that drives comment/anchor/wikilink resolution.
    const images = [...state.imageIndex].sort();
    const htmls = [...state.htmlIndex].sort();
    const pdfs = [...state.pdfIndex].sort();
    const drawings = [...state.drawingIndex].sort();
    return c.json({
      root: cfg.root,
      user: cfg.user,
      mdcVersion: VERSION,
      files,
      dirs,
      images,
      htmls,
      pdfs,
      drawings,
    });
  });

  // --- lightweight status: is a browser tab connected? ----------------------
  // Lets the CLI decide whether to spawn a tab (none connected) or stay quiet
  // (a tab is live and will just navigate), without the heavyweight index scan.
  app.get("/api/status", (c) => {
    return c.json({ tabConnected: openListeners.size > 0 });
  });

  // --- cross-doc dashboard --------------------------------------------------
  app.get("/api/dashboard", (c) => {
    rescan();
    const orphanSet = new Set(findOrphanSidecars(cfg.root, deny));
    const ordered = [...[...state.index].sort(), ...[...orphanSet].sort()];
    const files: Array<Record<string, unknown>> = [];
    let totalOpen = 0;
    let totalResolved = 0;
    for (const rel of ordered) {
      const scPath = join(cfg.root, rel) + ".comments.jsonl";
      const entries = readSidecar(scPath);
      if (entries.length === 0) continue;
      const threads = deriveThreads(entries, cfg.user);
      if (threads.length === 0) continue; // all-tombstone / empty — nothing to show
      const openN = threads.filter((t) => t.status === "open").length;
      const resolvedN = threads.length - openN;
      totalOpen += openN;
      totalResolved += resolvedN;
      files.push({
        path: rel,
        open: openN,
        resolved: resolvedN,
        orphaned: orphanSet.has(rel),
        threads,
      });
    }
    return c.json({
      root: cfg.root,
      total_open: totalOpen,
      total_resolved: totalResolved,
      files,
    });
  });

  // --- doc content ----------------------------------------------------------
  app.get("/api/md", (c) => {
    const file = requireQuery(c, "file");
    const { mdPath } = resolveFile(cfg.root, state.index, file);
    let content: string;
    try {
      content = readFileSync(mdPath, "utf8");
    } catch {
      throw new HttpError(404, `file not found on disk: ${file}`);
    }
    // `version` lets a caller do a conflict-safe read-modify-write: pass it
    // back as `baseVersion` on PUT and the write is rejected if the file
    // changed in between.
    return c.json({ content, filename: baseName(mdPath), path: file, version: fileVersion(content) });
  });

  // Overwrite a doc's content on disk. The only route that writes the .md
  // itself (all others write the sidecar). Same index + traversal confinement
  // as the read route, so it can never write outside the served root.
  app.put("/api/md", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const b = await c.req.json<{ content?: string; baseVersion?: string }>();
    if (typeof b.content !== "string") throw new HttpError(400, "content required");
    // Kept for edit capture below — read before the write, not after.
    let previous: string | null;
    try {
      previous = readFileSync(mdPath, "utf8");
    } catch {
      previous = null;
    }
    // With a baseVersion, a write against a file that changed since that read
    // is a conflict — never a silent clobber. Omitting baseVersion is a blind
    // write (kept for writers that don't track versions).
    if (b.baseVersion !== undefined) {
      if (previous === null || fileVersion(previous) !== b.baseVersion) {
        throw new HttpError(409, `${file} changed underneath you — reload`);
      }
    }
    try {
      writeFileSync(mdPath, b.content, "utf8");
    } catch {
      throw new HttpError(500, `failed to write: ${file}`);
    }
    // Edit capture: a save through this endpoint is a person editing in the
    // browser (agents write through the CLI and the filesystem), so record what
    // they changed as threads they authored. The write above already happened
    // and is untouched by this — the threads are a notification, not a gate.
    // MDC_NO_EDIT_CAPTURE=1 turns it off.
    if (previous !== null && process.env.MDC_NO_EDIT_CAPTURE !== "1") {
      try {
        const hunks = diffEdits(previous, b.content);
        const write = (body: string, quote: string): void => {
          appendEntry(scPath, {
            id: newId(),
            file: basename(mdPath),
            anchor: { quote },
            parent_id: null,
            author: cfg.user,
            body,
            timestamp: nowIso(),
          });
        };
        if (hunks.length > MAX_CAPTURED_HUNKS) {
          const first = hunks[0]!;
          write(
            `✏️ ${cfg.user} rewrote this document while reviewing — ${hunks.length} separate ` +
              `changes, too many to thread individually. Diff it against your copy rather than ` +
              `reading them one by one.`,
            first.quote,
          );
        } else {
          for (const h of hunks) write(hunkBody(h, cfg.user), h.quote);
        }
      } catch {
        // Capture is best-effort: never fail a save because the diff or the
        // sidecar append went wrong. The edit itself is already on disk.
      }
    }
    return c.json({ ok: true, path: file, version: fileVersion(b.content) });
  });

  // --- image serving --------------------------------------------------------
  app.get("/api/image", (c) => {
    const doc = requireQuery(c, "doc");
    const ref = requireQuery(c, "ref");
    const rel = resolveImage(state.imageIndex, doc, ref);
    if (rel === null) throw new HttpError(404, `image not found: ${ref}`);
    const imgPath = resolveImageFile(cfg.root, rel);
    return c.body(toBytes(readFileSync(imgPath)), 200, {
      "content-type": contentTypeFor(imgPath),
    });
  });

  // Store an image beside an indexed markdown doc. The client suggests the
  // filename; placement and collision-safe deduplication stay server-owned so
  // concurrent uploads cannot overwrite an existing asset.
  app.post("/api/asset", async (c) => {
    const doc = requireQuery(c, "doc");
    const name = requireQuery(c, "name");
    resolveFile(cfg.root, state.index, doc);

    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new HttpError(404, "path traversal blocked");
    }
    const extension = extname(name);
    if (!IMAGE_EXTS.has(extension.toLowerCase())) {
      throw new HttpError(400, "unsupported image extension");
    }

    const declaredSize = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_ASSET_BYTES) {
      throw new HttpError(413, "image exceeds the 25 MB limit");
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new HttpError(413, "image exceeds the 25 MB limit");
    }

    const docDir = posix.dirname(doc);
    const assetsDir = docDir === "." ? "assets" : posix.join(docDir, "assets");
    const assetsAbs = resolveWithinRoot(cfg.root, assetsDir);
    try {
      mkdirSync(assetsAbs, { recursive: true });
    } catch {
      throw new HttpError(500, `failed to create assets folder for: ${doc}`);
    }

    const stem = name.slice(0, -extension.length);
    let finalName = name;
    let targetAbs = "";
    for (let suffix = 0; ; suffix++) {
      finalName = suffix === 0 ? name : `${stem}-${suffix}${extension}`;
      const targetRel = posix.join(assetsDir, finalName);
      targetAbs = resolveWithinRoot(cfg.root, targetRel);
      try {
        writeFileSync(targetAbs, bytes, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw new HttpError(500, `failed to write asset for: ${doc}`);
      }
    }

    rescan();
    const path = relative(cfg.root, targetAbs).split(sep).join("/");
    return c.json({ path, ref: posix.join("assets", finalName) });
  });

  // Serve an image by its OWN indexed path (the standalone image view). Unlike
  // /api/image (which resolves a ref relative to a referencing doc), this opens
  // an image directly — there is no doc context, only the image's path.
  app.get("/api/image-file", (c) => {
    rescan(); // a freshly-added image must be servable without a manual reload
    const path = requireQuery(c, "path");
    const rel = resolveIndexedImage(state.imageIndex, path);
    if (rel === null) throw new HttpError(404, `image not in index: ${path}`);
    const imgPath = resolveImageFile(cfg.root, rel);
    return c.body(toBytes(readFileSync(imgPath)), 200, {
      "content-type": contentTypeFor(imgPath),
    });
  });

  // Serve an HTML file by its own indexed path (the sandboxed HTML view). The
  // bytes are rendered in an opaque-origin sandboxed iframe on the client, so
  // they can't script or reach the app; a strict CSP here is defense-in-depth
  // (the iframe sandbox is the primary control). Same-origin reads are off, so
  // only data/blob images and inline styles are permitted — no network egress.
  app.get("/api/html-file", (c) => {
    rescan(); // a freshly-added .html must be servable without a manual reload
    const path = requireQuery(c, "path");
    const rel = resolveIndexedHtml(state.htmlIndex, path);
    if (rel === null) throw new HttpError(404, `html not in index: ${path}`);
    const htmlPath = resolveHtmlFile(cfg.root, rel);
    return c.body(toBytes(readFileSync(htmlPath)), 200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'",
    });
  });

  // Serve a PDF file by its own indexed path. The client points an iframe's src
  // at these bytes so the browser's native PDF viewer renders the file.
  app.get("/api/pdf-file", (c) => {
    rescan(); // a freshly-added .pdf must be servable without a manual reload
    const path = requireQuery(c, "path");
    const rel = resolveIndexedPdf(state.pdfIndex, path);
    if (rel === null) throw new HttpError(404, `pdf not in index: ${path}`);
    const pdfPath = resolvePdfFile(cfg.root, rel);
    return c.body(toBytes(readFileSync(pdfPath)), 200, {
      "content-type": "application/pdf",
    });
  });

  // Return an indexed Excalidraw scene as text. Parsing stays client-side so a
  // malformed scene produces a file-level render error rather than a server crash.
  app.get("/api/drawing", (c) => {
    rescan();
    const file = requireQuery(c, "file");
    const rel = resolveIndexedDrawing(state.drawingIndex, file);
    if (rel === null) throw new HttpError(404, `drawing not in index: ${file}`);
    const drawingPath = resolveDrawingFile(cfg.root, rel);
    let content: string;
    try {
      content = readFileSync(drawingPath, "utf8");
    } catch {
      throw new HttpError(404, `drawing not found on disk: ${file}`);
    }
    return c.json({
      content,
      filename: baseName(drawingPath),
      path: file,
      version: fileVersion(content),
    });
  });

  // Overwrite an indexed Excalidraw scene with the same optimistic-concurrency
  // contract as markdown writes. A stale editor must reload rather than clobber
  // a drawing that changed on disk.
  app.put("/api/drawing", async (c) => {
    rescan();
    const file = requireQuery(c, "file");
    const rel = resolveIndexedDrawing(state.drawingIndex, file);
    if (rel === null) throw new HttpError(404, `drawing not in index: ${file}`);
    const drawingPath = resolveDrawingFile(cfg.root, rel);
    const body = await c.req.json<{ content?: string; baseVersion?: string }>();
    if (typeof body.content !== "string") throw new HttpError(400, "content required");

    if (body.baseVersion !== undefined) {
      let current: string | null;
      try {
        current = readFileSync(drawingPath, "utf8");
      } catch {
        current = null;
      }
      if (current === null || fileVersion(current) !== body.baseVersion) {
        throw new HttpError(409, `${file} changed underneath you — reload`);
      }
    }

    try {
      writeFileSync(drawingPath, body.content, "utf8");
    } catch {
      throw new HttpError(500, `failed to write: ${file}`);
    }
    return c.json({ ok: true, path: file, version: fileVersion(body.content) });
  });

  app.on("HEAD", "/api/pdf-file", (c) => {
    rescan(); // keep the existence check consistent with GET
    const path = requireQuery(c, "path");
    const rel = resolveIndexedPdf(state.pdfIndex, path);
    if (rel === null) throw new HttpError(404, `pdf not in index: ${path}`);
    resolvePdfFile(cfg.root, rel);
    return c.body(null, 200, {
      "content-type": "application/pdf",
    });
  });

  // --- trusted app bridge ---------------------------------------------------
  // The parent (frontend) owns ALL file I/O for a trusted HTML app: the iframe
  // runs sandboxed (allow-scripts only, opaque origin) and reaches these routes
  // via postMessage → the parent → here. Every op re-reads the app's bytes to
  // re-hash, so trust means "this exact version"; an edited app stops being
  // trusted mid-session. Scope (own folder + manifest) is enforced per call.

  /**
   * Resolve + validate an app by its root-relative path: it must be an indexed
   * HTML file, currently trusted (hash match), and carry a parseable manifest.
   * Returns the absolute path, manifest (or null for same-folder default), and
   * raw bytes. Throws HttpError otherwise.
   */
  function loadTrustedApp(appRel: string): {
    rel: string;
    absPath: string;
    manifest: AppManifest | null;
    bytes: Buffer;
  } {
    rescan();
    const rel = resolveIndexedHtml(state.htmlIndex, appRel);
    if (rel === null) throw new HttpError(404, `app not in index: ${appRel}`);
    const absPath = resolveHtmlFile(cfg.root, rel);
    const bytes = readFileSync(absPath);
    if (!isTrusted(cfg.root, rel, bytes)) throw new HttpError(403, `app not trusted: ${appRel}`);
    let manifest: AppManifest | null;
    try {
      manifest = parseManifest(bytes.toString("utf8"));
    } catch (e) {
      throw new HttpError(400, e instanceof ManifestError ? e.message : "bad app manifest");
    }
    return { rel, absPath, manifest, bytes };
  }

  /** Read an app's manifest WITHOUT requiring trust — for the info/prompt path. */
  function readAppManifest(appRel: string): { rel: string; manifest: AppManifest | null } {
    rescan();
    const rel = resolveIndexedHtml(state.htmlIndex, appRel);
    if (rel === null) throw new HttpError(404, `app not in index: ${appRel}`);
    const absPath = resolveHtmlFile(cfg.root, rel);
    let manifest: AppManifest | null;
    try {
      manifest = parseManifest(readFileSync(absPath, "utf8"));
    } catch (e) {
      throw new HttpError(400, e instanceof ManifestError ? e.message : "bad app manifest");
    }
    return { rel, manifest };
  }

  // App info — drives window.mdc.getAppInfo() and the trust prompt. Does NOT
  // require trust (the prompt needs the manifest of an untrusted app to show
  // what it would access); reports the current trust state.
  app.get("/api/app/info", (c) => {
    const appRel = requireQuery(c, "app");
    const { rel, manifest } = readAppManifest(appRel);
    const trusted = isTrusted(cfg.root, rel, readFileSync(resolveHtmlFile(cfg.root, rel)));
    return c.json({
      appPath: rel,
      rootName: baseName(cfg.root),
      permissions: manifest?.permissions ?? { read: [], write: [] },
      name: manifest?.name ?? null,
      trusted,
    });
  });

  // Trust an app: hash its current bytes and persist the [apps] entry.
  app.post("/api/app/trust", async (c) => {
    const b = await c.req.json<{ app?: string }>();
    if (typeof b.app !== "string" || !b.app.trim()) throw new HttpError(400, "app required");
    const { rel, manifest } = readAppManifest(b.app);
    const bytes = readFileSync(resolveHtmlFile(cfg.root, rel));
    trustApp(cfg.root, rel, bytes);
    return c.json({
      trusted: true,
      appPath: rel,
      permissions: manifest?.permissions ?? { read: [], write: [] },
    });
  });

  // window.mdc.readText(path) — read a file the app is scoped to read.
  app.get("/api/app/read", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const target = requireQuery(c, "path");
    if (!canRead(appRel, target, manifest)) throw new HttpError(403, `read denied: ${target}`);
    const abs = resolveWithinRoot(cfg.root, target);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      throw new HttpError(404, `file not found: ${target}`);
    }
    // `version` lets an app do a conflict-safe read-modify-write: pass it back
    // to writeText and the write is rejected if the file changed underneath.
    return c.json({ path: target, content, version: fileVersion(content) });
  });

  // window.mdc.writeText(path, content) — write a file the app is scoped to write.
  app.put("/api/app/write", async (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const target = requireQuery(c, "path");
    const body = await c.req.json<{ content?: string; baseVersion?: string }>();
    if (typeof body.content !== "string") throw new HttpError(400, "content required");
    if (!canWrite(appRel, target, manifest)) throw new HttpError(403, `write denied: ${target}`);
    const abs = resolveWithinRoot(cfg.root, target);

    // Optimistic concurrency: when the app supplies the version it last read,
    // refuse the write if the file changed underneath (external edit, another
    // app, the user) — never a silent clobber. Omitting baseVersion is a blind
    // write (back-compat); a present base against a now-missing file is also a
    // conflict (it expected a prior state that's gone), not a silent re-create.
    if (body.baseVersion !== undefined) {
      let current: string | null;
      try {
        current = readFileSync(abs, "utf8");
      } catch {
        current = null;
      }
      if (current === null || fileVersion(current) !== body.baseVersion) {
        throw new HttpError(409, `${target} changed underneath you — reload`);
      }
    }

    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body.content, "utf8");
    } catch {
      throw new HttpError(500, `failed to write: ${target}`);
    }
    rescan(); // a freshly written file should index
    return c.json({ path: target, saved: true, version: fileVersion(body.content) });
  });

  // window.mdc.deleteFile(path) — delete a file the app is scoped to write.
  // Gated by canWrite (same scope as writeText — deleting is a write), plus the
  // sidecar cleanup the main delete does. No-op-succeeds if already gone.
  app.delete("/api/app/delete", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const target = requireQuery(c, "path");
    if (!canWrite(appRel, target, manifest)) throw new HttpError(403, `delete denied: ${target}`);
    const abs = resolveWithinRoot(cfg.root, target);
    let deleted = false;
    try {
      if (existsSync(abs)) {
        unlinkSync(abs);
        deleted = true;
      }
      const sc = sidecarPath(abs);
      if (existsSync(sc)) unlinkSync(sc);
    } catch {
      throw new HttpError(500, `failed to delete: ${target}`);
    }
    rescan();
    return c.json({ path: target, deleted });
  });

  // window.mdc.listFiles(dir, { recursive }) — list files the app is scoped to
  // read under dir. One level by default; recursive=1 walks the whole subtree
  // (files only — a granted folder means everything under it), pruning denied
  // dirs during the walk. Every entry is still gated by canRead.
  app.get("/api/app/list", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const dirRel = c.req.query("path") ?? "";
    const recursive = c.req.query("recursive") === "1";
    const absDir = dirRel === "" ? cfg.root : resolveWithinRoot(cfg.root, dirRel);
    const out: { path: string; type: "file" | "dir" }[] = [];

    if (recursive) {
      // walkFiles yields files (denied dirs pruned) relative to absDir; re-prefix
      // with dirRel to make each path root-relative, then scope-check it.
      for (const [sub] of walkFiles(absDir, deny)) {
        const rel = dirRel === "" ? sub : `${dirRel}/${sub}`;
        if (canRead(appRel, rel, manifest)) out.push({ path: rel, type: "file" });
      }
    } else {
      let entries: { name: string; isDir: boolean }[];
      try {
        entries = readdirSync(absDir, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isDir: d.isDirectory(),
        }));
      } catch {
        throw new HttpError(404, `not a directory: ${dirRel}`);
      }
      for (const e of entries) {
        const rel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
        // Only surface what the app may actually read.
        if (canRead(appRel, rel, manifest)) {
          out.push({ path: rel, type: e.isDir ? "dir" : "file" });
        }
      }
    }
    return c.json({ path: dirRel, entries: out.sort((a, b) => (a.path < b.path ? -1 : 1)) });
  });

  app.get("/api/app/read-frontmatter", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const dirRel = c.req.query("path") ?? "";
    const recursive = c.req.query("recursive") === "1";
    const absDir = dirRel === "" ? cfg.root : resolveWithinRoot(cfg.root, dirRel);
    const out: { path: string; frontmatter: string | null }[] = [];

    const addFile = (rel: string) => {
      if (!canRead(appRel, rel, manifest)) return;
      let content: string;
      try {
        content = readFileSync(resolveWithinRoot(cfg.root, rel), "utf8");
      } catch {
        return;
      }
      out.push({ path: rel, frontmatter: rawFrontmatter(content) });
    };

    if (recursive) {
      for (const [sub] of walkFiles(absDir, deny)) {
        addFile(dirRel === "" ? sub : `${dirRel}/${sub}`);
      }
    } else {
      let entries: { name: string; isFile: boolean }[];
      try {
        entries = readdirSync(absDir, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isFile: d.isFile(),
        }));
      } catch {
        throw new HttpError(404, `not a directory: ${dirRel}`);
      }
      for (const e of entries) {
        if (!e.isFile) continue;
        addFile(dirRel === "" ? e.name : `${dirRel}/${e.name}`);
      }
    }

    return c.json({ path: dirRel, entries: out.sort((a, b) => (a.path < b.path ? -1 : 1)) });
  });

  // window.mdc.watch(cb) — SSE stream of in-scope change notifications for a
  // trusted app. Unlike /api/events (which gates by an explicit file list and so
  // never reports a newly-created file), this filters every root change by the
  // app's read scope — so an added/edited/deleted file the app may read fires a
  // notify, the manual ↻ made automatic. Coarse: the event carries no path; the
  // app re-reads its own data. Trust + manifest are validated on connect; if the
  // app is edited mid-stream it stops being trusted, but the open stream keeps
  // its connect-time manifest (the app remounts on edit anyway → reconnects).
  app.get("/api/app/watch", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "{}" });
      let unsub: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        unsub = watcher.subscribe((_kind, rel) => {
          if (!canRead(appRel, rel, manifest)) return;
          void stream.writeSSE({ event: "changed", data: "{}" });
        });
        stream.onAbort(() => {
          unsub();
          resolve();
        });
      });
      const hb = setInterval(() => {
        void stream.writeSSE({ data: "", event: "heartbeat" });
      }, 30_000);
      await done;
      clearInterval(hb);
    });
  });

  // --- comments: read -------------------------------------------------------
  app.get("/api/comments", (c) => {
    const file = requireQuery(c, "file");
    const { scPath } = resolveFile(cfg.root, state.index, file);
    return c.json({ entries: readSidecar(scPath) });
  });

  // --- comments: create (top-level or reply) --------------------------------
  app.post("/api/comments", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const b = await c.req.json<{
      author: string;
      body: string;
      anchor?: Anchor | null;
      parent_id?: string | null;
    }>();
    if (!b.body?.trim()) throw new HttpError(400, "body required");
    const parentId = b.parent_id ?? null;
    const anchor = b.anchor ?? null;
    if (parentId === null && anchor === null) {
      throw new HttpError(400, "top-level comment must have an anchor");
    }
    if (parentId !== null) {
      const ids = new Set(readSidecar(scPath).map((e) => e.id));
      if (!ids.has(parentId)) throw new HttpError(400, `parent_id ${parentId} not found`);
    }
    const entry: Entry = {
      id: newId(),
      file: baseName(mdPath),
      anchor,
      parent_id: parentId,
      author: b.author,
      body: b.body,
      timestamp: nowIso(),
    };
    appendEntry(scPath, entry);
    return c.json(entry);
  });

  // --- comments: resolve ----------------------------------------------------
  app.post("/api/comments/resolve", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const a = await c.req.json<{
      thread_id: string;
      author: string;
      resolution?: "applied" | "dismissed";
      suggestion_id?: string;
    }>();
    const entries = readSidecar(scPath);
    let prepared: Entry[];
    try {
      const batch = [{
        type: "resolved",
        thread_id: a.thread_id,
        ...(a.resolution === undefined ? {} : { resolution: a.resolution }),
        ...(a.suggestion_id === undefined ? {} : { suggestion_id: a.suggestion_id }),
      }];
      if (a.resolution === "dismissed") {
        // Older readers keep qualified decisions across an unresolve. Pairing
        // known events leaves the suggestion decided without closing the thread.
        batch.push({ type: "unresolved", thread_id: a.thread_id });
      }
      prepared = buildEntries(
        batch,
        entries,
        baseName(mdPath),
        a.author,
      );
    } catch (error) {
      if (error instanceof ValidationError) throw new HttpError(400, error.message);
      throw error;
    }
    appendEntries(scPath, prepared);
    return c.json(prepared[0]);
  });

  // --- suggestions: apply --------------------------------------------------
  app.post("/api/suggestions/apply", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const body = await c.req.json<{
      thread_id?: string;
      suggestion_id?: string;
      author?: string;
    }>();
    if (!body.thread_id || !body.suggestion_id || !body.author) {
      throw new HttpError(400, "thread_id, suggestion_id, and author required");
    }

    const entries = readSidecar(scPath);
    let decision: Entry;
    try {
      const prepared = buildEntries(
        [{
          type: "resolved",
          thread_id: body.thread_id,
          resolution: "applied",
          suggestion_id: body.suggestion_id,
        }],
        entries,
        baseName(mdPath),
        body.author,
      );
      decision = prepared[0]!;
    } catch (error) {
      if (error instanceof ValidationError) throw new HttpError(400, error.message);
      throw error;
    }

    const suggestion = entries.find((entry) => entry.id === body.suggestion_id)!.suggestion!;
    const rawText = readFileSync(mdPath, "utf8");
    const applied = applySuggestion(rawText, suggestion);
    if (!applied.ok) {
      throw new HttpError(409, "suggestion target no longer matches the document");
    }

    writeFileSync(mdPath, applied.content, "utf8");
    appendEntry(scPath, decision);
    return c.json({
      content: applied.content,
      version: fileVersion(applied.content),
      entry: decision,
    });
  });

  app.post("/api/comments/resolve-system", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const body = await c.req.json<{ thread_ids?: unknown }>();
    if (!Array.isArray(body.thread_ids) || body.thread_ids.length === 0) {
      throw new HttpError(400, "thread_ids required");
    }
    const ids = body.thread_ids;
    if (!ids.every((id): id is string => typeof id === "string" && id.length > 0)) {
      throw new HttpError(400, "thread_ids must be non-empty strings");
    }
    const entries = readSidecar(scPath);
    const topById = new Map(topLevelComments(entries).map((t) => [t.id, t]));
    const prepared: Entry[] = [];
    for (const id of ids) {
      const top = topById.get(id);
      if (!top) throw new HttpError(400, `thread_id ${id} not found`);
      const anchor = top.anchor ?? ({} as Anchor);
      prepared.push({
        id: newId(),
        file: baseName(mdPath),
        type: "resolved",
        thread_id: id,
        anchor_snapshot: { quote: anchor.quote ?? "", line: anchor.line ?? null },
        author: "system",
        timestamp: nowIso(),
      });
    }
    for (const entry of prepared) appendEntry(scPath, entry);
    return c.json({ resolved: prepared.map((entry) => entry.thread_id) });
  });

  // --- comments: unresolve --------------------------------------------------
  app.post("/api/comments/unresolve", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const a = await c.req.json<{ thread_id: string; author: string }>();
    const entries = readSidecar(scPath);
    if (!topLevelComments(entries).some((t) => t.id === a.thread_id)) {
      throw new HttpError(400, `thread_id ${a.thread_id} not found`);
    }
    const entry: Entry = {
      id: newId(),
      file: baseName(mdPath),
      type: "unresolved",
      thread_id: a.thread_id,
      author: a.author,
      timestamp: nowIso(),
    };
    appendEntry(scPath, entry);
    return c.json(entry);
  });

  // --- comments: edit -------------------------------------------------------
  app.post("/api/comments/edit", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const a = await c.req.json<{ comment_id: string; body: string; author: string }>();
    if (!a.body?.trim()) throw new HttpError(400, "body required");
    const entries = readSidecar(scPath);
    if (!commentIds(entries).has(a.comment_id)) {
      throw new HttpError(400, `comment_id ${a.comment_id} not found`);
    }
    const entry: Entry = {
      id: newId(),
      file: baseName(mdPath),
      type: "edit",
      comment_id: a.comment_id,
      body: a.body,
      author: a.author,
      timestamp: nowIso(),
    };
    appendEntry(scPath, entry);
    return c.json(entry);
  });

  // --- comments: delete one -------------------------------------------------
  app.post("/api/comments/delete", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const a = await c.req.json<{ comment_id: string; author: string }>();
    const entries = readSidecar(scPath);
    if (!commentIds(entries).has(a.comment_id)) {
      throw new HttpError(400, `comment_id ${a.comment_id} not found`);
    }
    const entry: Entry = {
      id: newId(),
      file: baseName(mdPath),
      type: "deleted",
      comment_id: a.comment_id,
      author: a.author,
      timestamp: nowIso(),
    };
    appendEntry(scPath, entry);
    const pruned = pruneIfEmpty(scPath, cfg.user);
    return c.json({ ...entry, sidecar_pruned: pruned });
  });

  // --- comments: delete a whole thread (orphan-reaching) --------------------
  app.post("/api/comments/delete-thread", async (c) => {
    const file = requireQuery(c, "file");
    const scPath = resolveSidecarPath(cfg.root, file);
    const fileName = baseName(file);
    const a = await c.req.json<{ thread_id: string; author: string }>();
    const entries = readSidecar(scPath);
    if (!topLevelComments(entries).some((t) => t.id === a.thread_id)) {
      throw new HttpError(400, `thread_id ${a.thread_id} not found`);
    }
    const targets = new Set<string>([a.thread_id]);
    for (const e of entries) {
      if (!isEvent(e) && e.parent_id === a.thread_id) targets.add(e.id);
    }
    const ts = nowIso();
    for (const cid of targets) {
      appendEntry(scPath, {
        id: newId(),
        file: fileName,
        type: "deleted",
        comment_id: cid,
        author: a.author,
        timestamp: ts,
      });
    }
    const pruned = pruneIfEmpty(scPath, cfg.user);
    return c.json({ deleted: [...targets].sort(), sidecar_pruned: pruned });
  });

  // --- sidecar: delete entire file ------------------------------------------
  app.delete("/api/sidecar", (c) => {
    const file = requireQuery(c, "file");
    const scPath = resolveSidecarForDelete(cfg.root, file);
    try {
      statSync(scPath);
    } catch {
      return c.json({ deleted: false, reason: "no sidecar" });
    }
    unlinkSync(scPath);
    return c.json({ deleted: true });
  });

  // --- file/folder create + delete (the only routes that mutate the tree) ----
  // These can't resolve against the index (a new file isn't indexed; a deleted
  // folder isn't an entry), so they confine the path to root directly and
  // rescan() afterward so the file tree reflects the change.

  // Create an empty markdown doc or drawing. mkdir -p the parent; refuse if it already exists.
  app.post("/api/file", async (c) => {
    const b = await c.req.json<{ path?: string }>();
    if (typeof b.path !== "string" || !b.path.trim()) throw new HttpError(400, "path required");
    const drawing = isDrawingName(b.path);
    if (!b.path.endsWith(".md") && !drawing) {
      throw new HttpError(400, "file must end in .md, .excalidraw, or .excalidraw.json");
    }
    const abs = resolveWithinRoot(cfg.root, b.path);
    if (existsSync(abs)) throw new HttpError(409, `already exists: ${b.path}`);
    const content = drawing ? EMPTY_EXCALIDRAW_SCENE : "";
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    } catch {
      throw new HttpError(500, `failed to create: ${b.path}`);
    }
    rescan();
    return c.json({ ok: true, path: b.path, content });
  });

  // Create a folder. mkdir -p; refuse if it already exists.
  app.post("/api/folder", async (c) => {
    const b = await c.req.json<{ path?: string }>();
    if (typeof b.path !== "string" || !b.path.trim()) throw new HttpError(400, "path required");
    const abs = resolveWithinRoot(cfg.root, b.path);
    if (existsSync(abs)) throw new HttpError(409, `already exists: ${b.path}`);
    try {
      mkdirSync(abs, { recursive: true });
    } catch {
      throw new HttpError(500, `failed to create folder: ${b.path}`);
    }
    rescan();
    return c.json({ ok: true, path: b.path });
  });

  // Delete a doc AND its sidecar together (deliberate delete = full cleanup).
  // No-op-succeeds if already gone.
  app.delete("/api/file", (c) => {
    const file = requireQuery(c, "file");
    const abs = resolveWithinRoot(cfg.root, file);
    let deleted = false;
    if (existsSync(abs)) {
      unlinkSync(abs);
      deleted = true;
    }
    const sc = sidecarPath(abs);
    if (existsSync(sc)) unlinkSync(sc);
    rescan();
    return c.json({ deleted });
  });

  // Recursively delete a folder and everything under it (docs + sidecars +
  // nested folders) — the highest-risk op. resolveWithinRoot already refuses the
  // root itself and any traversal escape.
  app.delete("/api/folder", (c) => {
    const folder = requireQuery(c, "folder");
    const abs = resolveWithinRoot(cfg.root, folder);
    if (!existsSync(abs)) return c.json({ deleted: false, reason: "not found" });
    if (!statSync(abs).isDirectory()) throw new HttpError(400, `not a folder: ${folder}`);
    rmSync(abs, { recursive: true, force: true });
    rescan();
    return c.json({ deleted: true });
  });

  // Pre-flight summary for the folder-delete confirm: how many docs are under a
  // folder and how many carry open comments, so the UI can state the stakes.
  app.get("/api/folder/summary", (c) => {
    const folder = requireQuery(c, "folder");
    const abs = resolveWithinRoot(cfg.root, folder);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new HttpError(404, `not a folder: ${folder}`);
    }
    let docs = 0;
    let withComments = 0;
    // walkFiles yields [relativePath, name] within `abs`; the sidecar sits next
    // to each .md, so reuse the open-thread oracle to decide whether a doc
    // carries comments worth warning about in the confirm.
    for (const [rel, name] of walkFiles(abs, deny)) {
      if (!name.endsWith(".md")) continue;
      docs++;
      const scAbs = sidecarPath(join(abs, rel));
      if (existsSync(scAbs) && countOpenThreads(scAbs, cfg.user) > 0) withComments++;
    }
    return c.json({ docs, withComments });
  });

  // --- move/rename a doc or folder (the only route that RELOCATES) ----------
  // Moving a path-anchored file breaks its sidecar (path-anchored) and any
  // relative links at either end. The plan (shared with the preview route)
  // enumerates every consequence; this route applies it. Order matters: relocate
  // the .md + sidecar FIRST so the file is never moved-but-unfindable, then
  // rewrite links (best-effort, reported). A rewrite failure does not roll back
  // the move — the file is safely at its new home either way.
  app.post("/api/move", async (c) => {
    const b = await c.req.json<{ from?: string; to?: string }>();
    if (typeof b.from !== "string" || !b.from.trim()) throw new HttpError(400, "from required");
    if (typeof b.to !== "string" || !b.to.trim()) throw new HttpError(400, "to required");
    const fromAbs = resolveWithinRoot(cfg.root, b.from);
    const toAbs = resolveWithinRoot(cfg.root, b.to);
    if (!existsSync(fromAbs)) throw new HttpError(404, `not found: ${b.from}`);
    if (existsSync(toAbs)) throw new HttpError(409, `already exists: ${b.to}`);
    if (toAbs === fromAbs || toAbs.startsWith(fromAbs + "/")) {
      throw new HttpError(400, "cannot move a path into itself");
    }

    rescan(); // plan against the current tree
    const plan = planMove({ root: cfg.root, index: state.index, from: b.from, to: b.to });
    if (plan.collisions.length) {
      throw new HttpError(409, `destination collisions: ${plan.collisions.join(", ")}`);
    }

    // 1. Relocate the .md(s) + sidecar(s). For a folder, a single rename moves
    //    the whole subtree (sidecars included, since they live inside it).
    mkdirSync(dirname(toAbs), { recursive: true });
    renameSync(fromAbs, toAbs);
    if (!statSync(toAbs).isDirectory()) {
      const fromSc = sidecarPath(fromAbs);
      if (existsSync(fromSc)) renameSync(fromSc, sidecarPath(toAbs));
    }

    // 2. Rewrite links. Inbound docs sit at their original path; moved docs are
    //    now at their destination — write outbound edits there.
    rescan();
    let rewrittenDocs = 0;
    let rewrittenLinks = 0;
    for (const edit of [...plan.inboundEdits, ...plan.outboundEdits]) {
      try {
        writeFileSync(join(cfg.root, edit.path), edit.content, "utf8");
        rewrittenDocs++;
        rewrittenLinks += edit.rewrites.length;
      } catch {
        // best-effort: the move already succeeded; a failed rewrite is reported
        // via the (now lower) counts, not a 500 that implies the move failed.
      }
    }
    rescan();
    return c.json({
      moved: { from: b.from, to: b.to },
      docsMoved: plan.fileMoves.length,
      sidecarsRelocated: plan.fileMoves.filter((m) => m.hasSidecar).length,
      docsRewritten: rewrittenDocs,
      linksRewritten: rewrittenLinks,
    });
  });

  // Pre-flight blast radius for the move confirm — the dry run of POST /api/move.
  // Computes the exact same plan WITHOUT touching disk, so the counts a user
  // confirms are precisely what will execute.
  app.get("/api/move/preview", (c) => {
    const from = requireQuery(c, "from");
    const to = requireQuery(c, "to");
    resolveWithinRoot(cfg.root, from);
    resolveWithinRoot(cfg.root, to);
    if (!existsSync(join(cfg.root, from))) throw new HttpError(404, `not found: ${from}`);
    rescan();
    const plan = planMove({ root: cfg.root, index: state.index, from, to });
    return c.json({ from, to, ...planSummary(plan) });
  });

  // --- live-reload SSE (shared, multiplexed by file) ------------------------
  app.get("/api/events", (c) => {
    // ?file=a&file=b — the set of files this connection cares about. Unknown
    // files are skipped (a stale persisted tab can't 404 the whole stream).
    // Any openable file counts: markdown, drawing, HTML, PDF, and image views all want
    // live-reload, so admit a file in ANY openable index — not just
    // `state.index` (markdown), which would silently drop non-md changes.
    const requested = c.req.queries("file") ?? [];
    const watched = new Set<string>();
    for (const f of requested) {
      if (
        state.index.has(f) ||
        state.drawingIndex.has(f) ||
        state.htmlIndex.has(f) ||
        state.imageIndex.has(f) ||
        state.pdfIndex.has(f)
      ) {
        watched.add(f);
      }
    }
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "{}" });
      let unsub: () => void = () => {};
      const onOpen = (rel: string) => {
        void stream.writeSSE({ event: "open-file", data: JSON.stringify({ file: rel }) });
      };
      openListeners.add(onOpen);
      const done = new Promise<void>((resolve) => {
        unsub = watcher.subscribe((kind, rel) => {
          if (!watched.has(rel)) return;
          void stream.writeSSE({ event: kind, data: JSON.stringify({ file: rel }) });
        });
        stream.onAbort(() => {
          unsub();
          openListeners.delete(onOpen);
          resolve();
        });
      });
      // Heartbeat every 30s to keep the connection alive through idle proxies.
      const hb = setInterval(() => {
        void stream.writeSSE({ data: "", event: "heartbeat" });
      }, 30_000);
      await done;
      clearInterval(hb);
    });
  });

  // --- open a file in the connected browser tab (none spawned) ----------------
  // `mdc open` posts here when a server is already up: the file is broadcast to
  // every live SSE connection, which switches/adds it as a tab in place. Returns
  // delivered:false (404) if the file isn't in the index, or if no connection is
  // listening — the caller falls back to opening a browser tab itself.
  app.post("/api/open", async (c) => {
    const b = await c.req.json<{ file: string }>();
    const rel = String(b.file ?? "");
    // Docs, drawings, image files, HTML files, and PDF files are all openable.
    if (
      !state.index.has(rel) &&
      !state.drawingIndex.has(rel) &&
      !state.imageIndex.has(rel) &&
      !state.htmlIndex.has(rel) &&
      !state.pdfIndex.has(rel)
    ) {
      return c.json({ delivered: false, reason: "unknown file" }, 404);
    }
    if (openListeners.size === 0) {
      return c.json({ delivered: false, reason: "no browser tab listening" }, 409);
    }
    broadcastOpen(rel);
    return c.json({ delivered: true });
  });

  // --- handoff: open a session ----------------------------------------------
  app.post("/api/handoff/open", async (c) => {
    const b = await c.req.json<{ file: string }>();
    resolveFile(cfg.root, state.index, b.file); // validate file is in the index
    const s = handoff.open(b.file);
    return c.json({ sessionId: s.sessionId, file: s.file });
  });

  // --- handoff: fire the done signal ----------------------------------------
  app.post("/api/handoff/done", async (c) => {
    const b = await c.req.json<{ sessionId: string; intent: string }>();
    const s = handoff.get(b.sessionId);
    if (!s) return c.json({ ok: true, delivered: false });
    const delivered = s.watcherCount > 0;
    s.fire(b.intent);
    // No watcher attached right now: the agent is likely between poll chunks.
    // Latch this handoff so its next session (same file) picks it up, instead
    // of the click being lost in the re-arm gap.
    if (!delivered) handoff.recordLatch(s.file, b.intent);
    return c.json({ ok: true, delivered });
  });

  // --- handoff: SSE the agent blocks on -------------------------------------
  app.get("/api/handoff/events", (c) => {
    const sessionId = requireQuery(c, "sessionId");
    const s = handoff.get(sessionId);
    if (!s) throw new HttpError(404, `unknown sessionId: ${sessionId}`);
    return streamSSE(c, async (stream) => {
      // The agent connecting IS the presence signal: count up here, down on
      // disconnect, so an abrupt drop is reflected too.
      s.watcherCount += 1;
      s.hadWatcher = true;
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        s.watcherCount = Math.max(0, s.watcherCount - 1);
      });
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        // Race the done-signal against periodic heartbeats.
        while (!aborted) {
          const fired = await Promise.race([
            s.signal.then(() => true),
            sleep(20_000).then(() => false),
          ]);
          if (fired) {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ intent: s.intent, file: s.file }),
            });
            return;
          }
          await stream.writeSSE({ data: "", event: "heartbeat" });
        }
      } finally {
        if (!aborted) s.watcherCount = Math.max(0, s.watcherCount - 1);
      }
    });
  });

  // --- built frontend assets (hashed JS/CSS bundles under /assets/) ----------
  app.get("/assets/*", (c) => {
    const rel = c.req.path.slice("/".length); // e.g. "assets/index-AbC123.js"
    // Confine to staticDir: reject any traversal in the request path.
    if (rel.includes("..")) throw new HttpError(404, "not found");
    const filePath = join(cfg.staticDir, rel);
    let body: Buffer;
    try {
      body = readFileSync(filePath);
    } catch {
      throw new HttpError(404, `not found: ${rel}`);
    }
    // Vite content-hashes asset filenames, so they're safe to cache forever.
    return c.body(toBytes(body), 200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  // --- handoff: presence ----------------------------------------------------
  app.get("/api/handoff/sessions", (c) => {
    const s = handoff.active();
    if (!s) return c.json({ active: null });
    return c.json({
      active: {
        sessionId: s.sessionId,
        file: s.file,
        created_at: s.createdAt / 1000, // epoch seconds
        watching: s.watcherCount > 0,
      },
    });
  });

  return { app, watcher };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { Context } from "hono";

function requireQuery(c: Context, name: string): string {
  const v = c.req.query(name);
  if (v === undefined) throw new HttpError(422, `missing query param: ${name}`);
  return v;
}

/** Ids of real comments/replies (excludes event lines). Edit/delete target these. */
function commentIds(entries: Entry[]): Set<string> {
  return new Set(entries.filter((e) => !isEvent(e)).map((e) => e.id));
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Escape text for interpolation into HTML — folder names can contain `<`/`&`. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A plain-ArrayBuffer Uint8Array copy of a Buffer, for Hono's c.body(). */
function toBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(buf.byteLength);
  const out = new Uint8Array(ab);
  out.set(buf);
  return out;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
function contentTypeFor(path: string): string {
  const i = path.lastIndexOf(".");
  const ext = i < 0 ? "" : path.slice(i).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
