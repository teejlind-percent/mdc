import {
  CONFIG_FILENAME,
  SIDECAR_SUFFIX,
  VERSION,
  ValidationError,
  appendEntries,
  appendEntry,
  applySuggestion,
  buildEntries,
  countOpenThreads,
  currentUserWithSource,
  deriveThreads,
  isEvent,
  newId,
  nowIso,
  pruneIfEmpty,
  readSidecar,
  topLevelComments
} from "./chunk-5DLARLQ5.js";

// src/server/serve.ts
import { serve as honoServe } from "@hono/node-server";
import { existsSync as existsSync5, statSync as statSync3 } from "fs";
import { dirname as dirname3, join as join6, resolve as resolve2 } from "path";
import { fileURLToPath } from "url";

// src/server/walk.ts
import { existsSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
var DEFAULT_DENY = /* @__PURE__ */ new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  ".next",
  "dist",
  "build",
  "__pycache__"
]);
var IMAGE_EXTS = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp"
]);
var HTML_EXTS = /* @__PURE__ */ new Set([".html", ".htm"]);
var PDF_EXTS = /* @__PURE__ */ new Set([".pdf"]);
function isDrawingName(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.json");
}
function extOf(name) {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i).toLowerCase();
}
function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}
function* walkFiles(root, deny) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!deny.has(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        yield [toPosix(relative(root, full)), ent.name];
      }
    }
  }
}
function buildIndex(root, deny) {
  const out = /* @__PURE__ */ new Set();
  for (const [rel, name] of walkFiles(root, deny)) {
    if (name.endsWith(".md")) out.add(rel);
  }
  return out;
}
function buildDirIndex(root, deny) {
  const out = /* @__PURE__ */ new Set();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || deny.has(ent.name)) continue;
      const full = join(dir, ent.name);
      out.add(toPosix(relative(root, full)));
      stack.push(full);
    }
  }
  return out;
}
function buildImageIndex(root, deny) {
  const out = /* @__PURE__ */ new Set();
  for (const [rel, name] of walkFiles(root, deny)) {
    if (IMAGE_EXTS.has(extOf(name))) out.add(rel);
  }
  return out;
}
function buildHtmlIndex(root, deny) {
  const out = /* @__PURE__ */ new Set();
  for (const [rel, name] of walkFiles(root, deny)) {
    if (HTML_EXTS.has(extOf(name))) out.add(rel);
  }
  return out;
}
function buildPdfIndex(root, deny) {
  const out = /* @__PURE__ */ new Set();
  for (const [rel, name] of walkFiles(root, deny)) {
    if (PDF_EXTS.has(extOf(name))) out.add(rel);
  }
  return out;
}
function buildDrawingIndex(root, deny) {
  const out = /* @__PURE__ */ new Set();
  for (const [rel, name] of walkFiles(root, deny)) {
    if (isDrawingName(name)) out.add(rel);
  }
  return out;
}
function findOrphanSidecars(root, deny) {
  const orphans = [];
  for (const [rel, name] of walkFiles(root, deny)) {
    if (!name.endsWith(SIDECAR_SUFFIX)) continue;
    const mdRel = rel.slice(0, -SIDECAR_SUFFIX.length);
    if (!existsSync(join(root, mdRel))) orphans.push(mdRel);
  }
  return orphans;
}
function denyFrom(extraRaw) {
  const deny = new Set(DEFAULT_DENY);
  for (const s of extraRaw.split(",")) {
    const t = s.trim();
    if (t) deny.add(t);
  }
  return deny;
}

// src/server/app.ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  existsSync as existsSync4,
  mkdirSync,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  renameSync,
  rmSync,
  statSync as statSync2,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "fs";
import { basename, dirname as dirname2, extname, join as join5, posix as posix5, relative as relative5, sep as sep4 } from "path";

// src/server/handoff-state.ts
import { randomUUID } from "crypto";
var SESSION_TTL_MS = 36e5;
var ATTACH_GRACE_MS = 1e4;
var LATCH_TTL_MS = 15e3;
function makeSession(file) {
  let resolveSignal;
  const signal = new Promise((res) => {
    resolveSignal = res;
  });
  const s = {
    sessionId: randomUUID().replace(/-/g, ""),
    file,
    createdAt: Date.now(),
    intent: null,
    watcherCount: 0,
    hadWatcher: false,
    done: false,
    signal,
    fire(intent) {
      if (this.done) return;
      this.intent = intent;
      this.done = true;
      resolveSignal();
    }
  };
  return s;
}
var HandoffRegistry = class {
  sessions = /* @__PURE__ */ new Map();
  /** At most one latched handoff (single active session ⇒ single latch). */
  latch = null;
  reap() {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(sid);
    }
    if (this.latch && now - this.latch.at > LATCH_TTL_MS) this.latch = null;
  }
  /**
   * Record a Hand off that fired with no watcher attached (the agent was between
   * poll chunks). The next session opened on the SAME file within LATCH_TTL_MS
   * consumes it. Only ever called for a real, existing session's `done` — so the
   * "no agent ever" case (which never reaches `done`) can't latch.
   */
  recordLatch(file, intent) {
    this.latch = { file, intent, at: Date.now() };
  }
  get(sessionId) {
    this.reap();
    return this.sessions.get(sessionId);
  }
  /** The single currently-live (not-done) session, or null. */
  active() {
    this.reap();
    for (const s of this.sessions.values()) {
      if (!s.done) return s;
    }
    return null;
  }
  /**
   * A live-looking session nobody is actually waiting on: its watcher attached
   * and disconnected (timeout poll, Ctrl-C, crash), or it never attached within
   * the grace window. Such sessions must not block the next open — an agent
   * polling with `watch --timeout` abandons one per chunk.
   */
  abandoned(s) {
    if (s.watcherCount > 0) return false;
    if (s.hadWatcher) return true;
    return Date.now() - s.createdAt > ATTACH_GRACE_MS;
  }
  /**
   * Open a new session, superseding any abandoned one. Throws 409 only when a
   * session with a live (or still-arriving) watcher holds the slot.
   */
  open(file) {
    this.reap();
    for (const [sid, s2] of this.sessions) {
      if (!s2.done && this.abandoned(s2)) this.sessions.delete(sid);
    }
    const existing = this.active();
    if (existing) {
      const err = new Error(
        `another session is live on '${existing.file}'; wait for it to finish`
      );
      err.status = 409;
      throw err;
    }
    const s = makeSession(file);
    this.sessions.set(s.sessionId, s);
    if (this.latch && this.latch.file === file) {
      const { intent } = this.latch;
      this.latch = null;
      s.fire(intent);
    }
    return s;
  }
};

// src/edit-capture.ts
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4e6) return [];
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      table[i2][j2] = a[i2] === b[j2] ? table[i2 + 1][j2 + 1] + 1 : Math.max(table[i2 + 1][j2], table[i2][j2 + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
var firstNonEmpty = (lines) => {
  for (const l of lines) if (l.trim()) return l.trim();
  return null;
};
function diffEdits(oldText, newText) {
  if (oldText === newText) return [];
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const pairs = lcsPairs(a, b);
  const hunks = [];
  let ai = 0;
  let bi = 0;
  const flush = (oldLines, newLines, precedingCommon) => {
    const before = oldLines.join("\n").trim();
    const after = newLines.join("\n").trim();
    if (!before && !after) return;
    const quote = firstNonEmpty(newLines) ?? precedingCommon;
    if (!quote) return;
    hunks.push({ quote, before, after });
  };
  let lastCommon = null;
  for (const [pa, pb] of [...pairs, [a.length, b.length]]) {
    if (pa > ai || pb > bi) flush(a.slice(ai, pa), b.slice(bi, pb), lastCommon);
    if (pa < a.length) {
      const common = a[pa].trim();
      if (common) lastCommon = common;
    }
    ai = pa + 1;
    bi = pb + 1;
  }
  return hunks;
}
function hunkBody(hunk, author) {
  const q = (s) => `"${s.replace(/\s+/g, " ").trim()}"`;
  if (!hunk.before) return `\u270F\uFE0F ${author} added this while reviewing.`;
  if (!hunk.after) return `\u270F\uFE0F ${author} deleted ${q(hunk.before)} while reviewing.`;
  return `\u270F\uFE0F ${author} edited this while reviewing.

was: ${q(hunk.before)}
now: ${q(hunk.after)}`;
}
var MAX_CAPTURED_HUNKS = 15;
var CAPTURE_SETTLE_MS = 5e3;
var CaptureBuffer = class {
  constructor(onSettle, settleMs = CAPTURE_SETTLE_MS) {
    this.onSettle = onSettle;
    this.settleMs = settleMs;
  }
  onSettle;
  settleMs;
  pending = /* @__PURE__ */ new Map();
  /** Record a save. `previous` is the content on disk before this write. */
  note(key, previous) {
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
    const baseline = existing?.baseline ?? previous;
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.onSettle(key, baseline);
    }, this.settleMs);
    timer.unref?.();
    this.pending.set(key, { baseline, timer });
  }
  /** Fire any pending capture for `key` immediately (e.g. the file was closed). */
  flush(key) {
    const existing = this.pending.get(key);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.pending.delete(key);
    this.onSettle(key, existing.baseline);
  }
  /** Drop everything without firing — for shutdown and tests. */
  clear() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
};

// src/apps/manifest.ts
var ManifestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
};
var MANIFEST_BLOCK = /<!--\s*([\s\S]*?)-->/;
function parseManifest(html) {
  const block = findManifestBlock(html);
  if (block === null) return null;
  return parseManifestBody(block);
}
function findManifestBlock(html) {
  let rest = html;
  for (; ; ) {
    const m = MANIFEST_BLOCK.exec(rest);
    if (m === null) return null;
    const body = m[1] ?? "";
    const lines = body.split("\n");
    const idx = lines.findIndex((l) => l.trim() === "mdc-app:" || l.trim().startsWith("mdc-app:"));
    if (idx !== -1) return lines.slice(idx + 1);
    rest = rest.slice(m.index + m[0].length);
  }
}
function parseManifestBody(lines) {
  let name = "";
  const read = [];
  const write = [];
  let listTarget = null;
  let inPermissions = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (text.startsWith("- ")) {
      if (listTarget === null) {
        throw new ManifestError(`unexpected list item outside read/write: ${text}`);
      }
      listTarget.push(stripQuotes(text.slice(2).trim()));
      continue;
    }
    const colon = text.indexOf(":");
    if (colon === -1) throw new ManifestError(`expected "key: value", got: ${text}`);
    const key = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (indent === 0) {
      inPermissions = false;
      listTarget = null;
    }
    if (key === "name") {
      name = stripQuotes(value);
    } else if (key === "permissions") {
      inPermissions = true;
      listTarget = null;
    } else if (key === "read" && inPermissions) {
      listTarget = read;
    } else if (key === "write" && inPermissions) {
      listTarget = write;
    } else {
      throw new ManifestError(`unknown manifest key: ${key}`);
    }
  }
  if (!name) throw new ManifestError("manifest is missing a name");
  return { name, permissions: { read, write } };
}
function stripQuotes(s) {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

// src/apps/scope.ts
import { createHash } from "crypto";
import { posix } from "path";
function fileVersion(content) {
  return createHash("sha256").update(content).digest("hex");
}
function normalizeRel(p) {
  const cleaned = posix.normalize(p.replace(/^\/+/, ""));
  if (cleaned === ".." || cleaned.startsWith("../")) return null;
  return cleaned;
}
function appFolder(appPath) {
  const dir = posix.dirname(appPath);
  return dir === "." ? "" : dir;
}
function isWithin(prefix, target) {
  if (prefix === "") return true;
  return target === prefix || target.startsWith(prefix + "/");
}
function inDeclaredScopes(scopes, target) {
  for (const raw of scopes) {
    const scope = normalizeRel(raw);
    if (scope === null) continue;
    if (isWithin(scope, target)) return true;
  }
  return false;
}
function canRead(appPath, targetPath, manifest) {
  const app = normalizeRel(appPath);
  const target = normalizeRel(targetPath);
  if (app === null || target === null) return false;
  if (isWithin(appFolder(app), target)) return true;
  if (manifest && inDeclaredScopes(manifest.permissions.read, target)) return true;
  return false;
}
function canWrite(appPath, targetPath, manifest) {
  const app = normalizeRel(appPath);
  const target = normalizeRel(targetPath);
  if (app === null || target === null) return false;
  if (!canRead(appPath, targetPath, manifest)) return false;
  if (isWithin(appFolder(app), target)) return true;
  if (manifest && inDeclaredScopes(manifest.permissions.write, target)) return true;
  return false;
}

// src/apps/trust.ts
import { createHash as createHash2 } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join as join2 } from "path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
var APPS_TABLE = "apps";
function hashApp(bytes) {
  return createHash2("sha256").update(bytes).digest("hex");
}
function readConfig(root) {
  let text;
  try {
    text = readFileSync(join2(root, CONFIG_FILENAME), "utf8");
  } catch {
    return {};
  }
  try {
    return parseToml(text);
  } catch {
    return {};
  }
}
function appsTable(config) {
  const apps = config[APPS_TABLE];
  if (apps && typeof apps === "object") {
    const out = {};
    for (const [k, v] of Object.entries(apps)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  return {};
}
function isTrusted(root, appPath, currentBytes) {
  const stored = appsTable(readConfig(root))[appPath];
  return stored !== void 0 && stored === hashApp(currentBytes);
}
function trustApp(root, appPath, bytes) {
  const config = readConfig(root);
  const apps = appsTable(config);
  const hash = hashApp(bytes);
  apps[appPath] = hash;
  config[APPS_TABLE] = apps;
  writeFileSync(join2(root, CONFIG_FILENAME), stringifyToml(config), "utf8");
  return hash;
}

// src/move/plan.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, statSync } from "fs";
import { posix as posix3 } from "path";

// src/move/rewrite.ts
import { posix as posix2 } from "path";
var { dirname, join: join3, normalize, relative: relative2 } = posix2;
function isRelativeRef(ref) {
  if (!ref) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false;
  if (ref.startsWith("/")) return false;
  if (ref.startsWith("#")) return false;
  return true;
}
function splitSuffix(ref) {
  const m = ref.match(/^([^#?]*)([#?].*)?$/);
  return { path: m?.[1] ?? ref, suffix: m?.[2] ?? "" };
}
function resolveFrom(docPath, ref) {
  return normalize(join3(dirname(docPath), ref));
}
function relativeTo(docPath, target) {
  const rel = relative2(dirname(docPath), target);
  return rel === "" ? "." : rel;
}
var MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
var QUALIFIED_WIKILINK = /(!?)\[\[([^[\]\n|#]*\/[^[\]\n|#]*)((?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?)\]\]/g;
function* scanLinks(content) {
  MD_LINK.lastIndex = 0;
  let m;
  while ((m = MD_LINK.exec(content)) !== null) {
    const [full, bang, text, ref, title = ""] = m;
    yield {
      kind: "md",
      ref,
      rebuild: (nr) => `${bang}[${text}](${nr}${title})`,
      index: m.index,
      length: full.length
    };
  }
  QUALIFIED_WIKILINK.lastIndex = 0;
  while ((m = QUALIFIED_WIKILINK.exec(content)) !== null) {
    const [full, bang, target, suffix = ""] = m;
    yield {
      kind: "wikilink",
      ref: target,
      rebuild: (nr) => `${bang}[[${nr}${suffix}]]`,
      index: m.index,
      length: full.length
    };
  }
}
function applyRewrites(content, edits) {
  const rewrites = [];
  let out = content;
  for (const e of [...edits].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, e.index) + e.replacement + out.slice(e.index + e.length);
    rewrites.push({ from: e.from, to: e.to });
  }
  rewrites.reverse();
  return { content: out, rewrites };
}
function resolveTarget(hit, refPath, docPath) {
  if (hit.kind === "wikilink") {
    const withExt = refPath.endsWith(".md") ? refPath : refPath + ".md";
    return normalize(withExt);
  }
  return resolveFrom(docPath, refPath);
}
function refFor(hit, target, docPath) {
  if (hit.kind === "wikilink") {
    return target.endsWith(".md") ? target.slice(0, -3) : target;
  }
  return relativeTo(docPath, target);
}
function decide(hit, resolveDocPath, newDocPath, remap) {
  const { path: refPath, suffix } = splitSuffix(hit.ref);
  if (!isRelativeRef(refPath)) return null;
  const resolvedOld = resolveTarget(hit, refPath, resolveDocPath);
  const resolvedNew = remap(resolvedOld);
  if (resolvedNew === null) return null;
  const newRef = refFor(hit, resolvedNew, newDocPath) + suffix;
  if (newRef === hit.ref) return null;
  return {
    index: hit.index,
    length: hit.length,
    replacement: hit.rebuild(newRef),
    from: hit.ref,
    to: newRef
  };
}
function relinkOutbound(content, oldPath, newPath, moved) {
  const map = moved ?? /* @__PURE__ */ new Map([[oldPath, newPath]]);
  const edits = [];
  for (const hit of scanLinks(content)) {
    const edit = decide(hit, oldPath, newPath, (resolvedOld) => map.get(resolvedOld) ?? resolvedOld);
    if (edit) edits.push(edit);
  }
  return applyRewrites(content, edits);
}
function relinkInbound(content, linkingDocPath, oldPath, newPath) {
  const edits = [];
  for (const hit of scanLinks(content)) {
    const edit = decide(
      hit,
      linkingDocPath,
      linkingDocPath,
      (resolvedOld) => resolvedOld === oldPath ? newPath : null
    );
    if (edit) edits.push(edit);
  }
  return applyRewrites(content, edits);
}
function linksTo(content, linkingDocPath, target) {
  for (const hit of scanLinks(content)) {
    const { path: refPath } = splitSuffix(hit.ref);
    if (!isRelativeRef(refPath)) continue;
    if (resolveTarget(hit, refPath, linkingDocPath) === target) return true;
  }
  return false;
}

// src/move/plan.ts
var { join: join4 } = posix3;
function isUnder(dir, p) {
  return p === dir || p.startsWith(dir + "/");
}
function planMove(input) {
  const { root, index, from, to } = input;
  const fromAbs = join4(root, from);
  const isFolder = existsSync2(fromAbs) && statSync(fromAbs).isDirectory();
  const fileMoves = [];
  const movedFromTo = /* @__PURE__ */ new Map();
  if (isFolder) {
    for (const md of index) {
      if (!isUnder(from, md)) continue;
      const dest = to + md.slice(from.length);
      movedFromTo.set(md, dest);
    }
  } else {
    movedFromTo.set(from, to);
  }
  for (const [oldMd, newMd] of movedFromTo) {
    fileMoves.push({ from: oldMd, to: newMd, hasSidecar: existsSync2(join4(root, oldMd) + SIDECAR_SUFFIX) });
  }
  const collisions = [];
  for (const newMd of movedFromTo.values()) {
    if (existsSync2(join4(root, newMd)) && !movedFromTo.has(newMd)) collisions.push(newMd);
  }
  const inboundEdits = [];
  for (const linker of index) {
    if (movedFromTo.has(linker)) continue;
    let content = safeRead(join4(root, linker));
    if (content === null) continue;
    const rewrites = [];
    for (const [oldMd, newMd] of movedFromTo) {
      if (!linksTo(content, linker, oldMd)) continue;
      const res = relinkInbound(content, linker, oldMd, newMd);
      content = res.content;
      rewrites.push(...res.rewrites);
    }
    if (rewrites.length) inboundEdits.push({ path: linker, content, rewrites });
  }
  const outboundEdits = [];
  for (const [oldMd, newMd] of movedFromTo) {
    const src = safeRead(join4(root, oldMd));
    if (src === null) continue;
    const res = relinkOutbound(src, oldMd, newMd, movedFromTo);
    if (res.rewrites.length) {
      outboundEdits.push({ path: newMd, content: res.content, rewrites: res.rewrites });
    }
  }
  return { fileMoves, inboundEdits, outboundEdits, collisions };
}
function safeRead(abs) {
  try {
    return readFileSync2(abs, "utf8");
  } catch {
    return null;
  }
}
function planSummary(plan) {
  const docsToRewrite = (/* @__PURE__ */ new Set([
    ...plan.inboundEdits.map((e) => e.path),
    ...plan.outboundEdits.map((e) => e.path)
  ])).size;
  const linksToRewrite = plan.inboundEdits.reduce((n, e) => n + e.rewrites.length, 0) + plan.outboundEdits.reduce((n, e) => n + e.rewrites.length, 0);
  return {
    docsToMove: plan.fileMoves.length,
    sidecarsToRelocate: plan.fileMoves.filter((m) => m.hasSidecar).length,
    docsToRewrite,
    linksToRewrite,
    collisions: plan.collisions
  };
}

// src/server/paths.ts
import { existsSync as existsSync3 } from "fs";
import { posix as posix4, relative as relative3, resolve, sep as sep2 } from "path";
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
  status;
};
function toPosix2(p) {
  return sep2 === "/" ? p : p.split(sep2).join("/");
}
function isUnderRoot(root, child) {
  const rel = relative3(root, child);
  return rel === "" || !rel.startsWith("..") && !resolve(rel).includes("..");
}
function sidecarPath(mdPath) {
  return mdPath + SIDECAR_SUFFIX;
}
function resolveFile(root, index, fileParam) {
  if (!index.has(fileParam)) {
    throw new HttpError(404, `file not in index: ${fileParam}`);
  }
  const mdPath = resolve(root, fileParam);
  if (!isUnderRoot(root, mdPath)) throw new HttpError(404, "path traversal blocked");
  return { mdPath, scPath: sidecarPath(mdPath) };
}
function resolveSidecarPath(root, fileParam) {
  const mdPath = resolve(root, fileParam);
  if (!isUnderRoot(root, mdPath)) throw new HttpError(404, "path traversal blocked");
  const scPath = sidecarPath(mdPath);
  if (!existsSync3(scPath)) throw new HttpError(404, `no sidecar for: ${fileParam}`);
  return scPath;
}
function resolveSidecarForDelete(root, fileParam) {
  const mdPath = resolve(root, fileParam);
  if (!isUnderRoot(root, mdPath)) throw new HttpError(404, "path traversal blocked");
  return sidecarPath(mdPath);
}
function resolveWithinRoot(root, relParam) {
  const abs = resolve(root, relParam);
  if (!isUnderRoot(root, abs)) throw new HttpError(404, "path traversal blocked");
  if (abs === resolve(root)) throw new HttpError(400, "refusing to operate on the root itself");
  return abs;
}
function resolveImage(imageIndex, docPath, rawRef) {
  const ext = (p) => {
    const i = p.lastIndexOf(".");
    return i <= 0 ? "" : p.slice(i).toLowerCase();
  };
  const ref = rawRef.trim().replace(/^\/+/, "");
  const docDir = posix4.dirname(docPath);
  let cand = posix4.normalize(posix4.join(docDir, ref));
  if (!cand.startsWith("..") && imageIndex.has(cand)) return cand;
  cand = posix4.normalize(ref);
  if (!cand.startsWith("..") && imageIndex.has(cand)) return cand;
  const base = posix4.basename(ref);
  if (!IMAGE_EXTS.has(ext(base))) return null;
  const matches = [...imageIndex].filter((p) => posix4.basename(p) === base);
  if (matches.length === 0) return null;
  const docParts = docDir.split("/").filter(Boolean);
  const sharedPrefix = (p) => {
    const pp = p.split("/").filter(Boolean);
    let n = 0;
    for (let i = 0; i < Math.min(docParts.length, pp.length); i++) {
      if (docParts[i] !== pp[i]) break;
      n++;
    }
    return n;
  };
  matches.sort((a, b) => {
    const sp = sharedPrefix(b) - sharedPrefix(a);
    if (sp !== 0) return sp;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return matches[0] ?? null;
}
function resolveIndexedImage(imageIndex, pathParam) {
  return imageIndex.has(pathParam) ? pathParam : null;
}
function resolveImageFile(root, rel) {
  const imgPath = resolve(root, rel);
  if (!isUnderRoot(root, imgPath)) throw new HttpError(404, "path traversal blocked");
  if (!existsSync3(imgPath)) throw new HttpError(404, `image not found on disk: ${rel}`);
  return imgPath;
}
function resolveIndexedHtml(htmlIndex, pathParam) {
  return htmlIndex.has(pathParam) ? pathParam : null;
}
function resolveHtmlFile(root, rel) {
  const htmlPath = resolve(root, rel);
  if (!isUnderRoot(root, htmlPath)) throw new HttpError(404, "path traversal blocked");
  if (!existsSync3(htmlPath)) throw new HttpError(404, `html not found on disk: ${rel}`);
  return htmlPath;
}
function resolveIndexedPdf(pdfIndex, pathParam) {
  return pdfIndex.has(pathParam) ? pathParam : null;
}
function resolvePdfFile(root, rel) {
  const pdfPath = resolve(root, rel);
  if (!isUnderRoot(root, pdfPath)) throw new HttpError(404, "path traversal blocked");
  if (!existsSync3(pdfPath)) throw new HttpError(404, `pdf not found on disk: ${rel}`);
  return pdfPath;
}
function resolveIndexedDrawing(drawingIndex, pathParam) {
  return drawingIndex.has(pathParam) ? pathParam : null;
}
function resolveDrawingFile(root, rel) {
  const drawingPath = resolve(root, rel);
  if (!isUnderRoot(root, drawingPath)) throw new HttpError(404, "path traversal blocked");
  if (!existsSync3(drawingPath)) throw new HttpError(404, `drawing not found on disk: ${rel}`);
  return drawingPath;
}
function baseName(p) {
  return posix4.basename(toPosix2(p));
}

// src/server/watcher.ts
import chokidar from "chokidar";
import { relative as relative4, sep as sep3 } from "path";
function isSidecarPath(path) {
  return path.endsWith(SIDECAR_SUFFIX);
}
function toPosix3(p) {
  return sep3 === "/" ? p : p.split(sep3).join("/");
}
var RootWatcher = class {
  watcher;
  listeners = /* @__PURE__ */ new Set();
  constructor(root, deny = DEFAULT_DENY) {
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      // Prune denied dirs (.git, node_modules, …) so we don't fire on their
      // churn — same deny list the index walk uses, so the two stay in sync.
      ignored: (path) => {
        const rel = relative4(root, path);
        if (!rel) return false;
        return rel.split(sep3).some((seg) => deny.has(seg));
      }
    });
    for (const ev of ["add", "change", "unlink"]) {
      this.watcher.on(ev, (path) => {
        const rel = toPosix3(relative4(root, path));
        if (isSidecarPath(path)) {
          this.dispatch("sidecar-changed", rel.slice(0, -SIDECAR_SUFFIX.length));
        } else {
          this.dispatch("doc-changed", rel);
        }
      });
    }
  }
  dispatch(kind, relPath) {
    for (const l of this.listeners) l(kind, relPath);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close() {
    await this.watcher.close();
  }
};

// src/server/app.ts
var EMPTY_EXCALIDRAW_SCENE = '{"type":"excalidraw","version":2,"source":"mdc","elements":[],"appState":{},"files":{}}';
var MAX_ASSET_BYTES = 25 * 1024 * 1024;
function rawFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const body = content.slice(4);
  const close = /\n---(?:\n|$)/.exec(body);
  if (!close) return null;
  return body.slice(0, close.index);
}
function createApp(cfg) {
  const deny = denyFrom(cfg.denyRaw);
  const state = {
    index: buildIndex(cfg.root, deny),
    drawingIndex: buildDrawingIndex(cfg.root, deny),
    imageIndex: buildImageIndex(cfg.root, deny),
    htmlIndex: buildHtmlIndex(cfg.root, deny),
    pdfIndex: buildPdfIndex(cfg.root, deny)
  };
  const handoff = new HandoffRegistry();
  const watcher = new RootWatcher(cfg.root, deny);
  const openListeners = /* @__PURE__ */ new Set();
  function broadcastOpen(rel) {
    for (const l of openListeners) l(rel);
  }
  function rescan() {
    state.index = buildIndex(cfg.root, deny);
    state.drawingIndex = buildDrawingIndex(cfg.root, deny);
    state.imageIndex = buildImageIndex(cfg.root, deny);
    state.htmlIndex = buildHtmlIndex(cfg.root, deny);
    state.pdfIndex = buildPdfIndex(cfg.root, deny);
  }
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ detail: err.message }, err.status);
    const status = err.status;
    if (status) return c.json({ detail: err.message }, status);
    console.error(err);
    return c.json({ detail: "internal error" }, 500);
  });
  const workspaceTitle = `mdc \u2014 ${basename(cfg.root)}`;
  app.get("/", (c) => {
    const html = readFileSync3(join5(cfg.staticDir, "index.html"), "utf8");
    return c.html(html.replace("<title>mdc</title>", `<title>${escapeHtml(workspaceTitle)}</title>`));
  });
  const rootStatics = {
    "/favicon.svg": "image/svg+xml",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
    "/apple-touch-icon.png": "image/png"
  };
  for (const [path, contentType] of Object.entries(rootStatics)) {
    app.get(path, (c) => {
      try {
        const body = readFileSync3(join5(cfg.staticDir, path.slice(1)));
        return c.body(toBytes(body), 200, {
          "content-type": contentType,
          "cache-control": "public, max-age=86400"
        });
      } catch {
        throw new HttpError(404, "not found");
      }
    });
  }
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
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }
        ]
      }),
      200,
      {
        "content-type": "application/manifest+json",
        "cache-control": "public, max-age=86400"
      }
    );
  });
  app.get("/api/index", (c) => {
    rescan();
    const files = [...state.index].sort().map((rel) => ({
      path: rel,
      openThreadCount: countOpenThreads(join5(cfg.root, rel) + ".comments.jsonl", cfg.user)
    }));
    const dirs = [...buildDirIndex(cfg.root, deny)].sort();
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
      drawings
    });
  });
  app.get("/api/status", (c) => {
    return c.json({ tabConnected: openListeners.size > 0 });
  });
  app.get("/api/dashboard", (c) => {
    rescan();
    const orphanSet = new Set(findOrphanSidecars(cfg.root, deny));
    const ordered = [...[...state.index].sort(), ...[...orphanSet].sort()];
    const files = [];
    let totalOpen = 0;
    let totalResolved = 0;
    for (const rel of ordered) {
      const scPath = join5(cfg.root, rel) + ".comments.jsonl";
      const entries = readSidecar(scPath);
      if (entries.length === 0) continue;
      const threads = deriveThreads(entries, cfg.user);
      if (threads.length === 0) continue;
      const openN = threads.filter((t) => t.status === "open").length;
      const resolvedN = threads.length - openN;
      totalOpen += openN;
      totalResolved += resolvedN;
      files.push({
        path: rel,
        open: openN,
        resolved: resolvedN,
        orphaned: orphanSet.has(rel),
        threads
      });
    }
    return c.json({
      root: cfg.root,
      total_open: totalOpen,
      total_resolved: totalResolved,
      files
    });
  });
  app.get("/api/md", (c) => {
    const file = requireQuery(c, "file");
    const { mdPath } = resolveFile(cfg.root, state.index, file);
    let content;
    try {
      content = readFileSync3(mdPath, "utf8");
    } catch {
      throw new HttpError(404, `file not found on disk: ${file}`);
    }
    return c.json({ content, filename: baseName(mdPath), path: file, version: fileVersion(content) });
  });
  const captures = new CaptureBuffer((mdPath, baseline) => {
    try {
      const current = readFileSync3(mdPath, "utf8");
      const hunks = diffEdits(baseline, current);
      if (hunks.length === 0) return;
      const scPath = sidecarPath(mdPath);
      const write = (body, quote) => {
        appendEntry(scPath, {
          id: newId(),
          file: basename(mdPath),
          anchor: { quote },
          parent_id: null,
          author: cfg.user,
          body,
          timestamp: nowIso()
        });
      };
      if (hunks.length > MAX_CAPTURED_HUNKS) {
        write(
          `\u270F\uFE0F ${cfg.user} rewrote this document while reviewing \u2014 ${hunks.length} separate changes, too many to thread individually. Diff it against your copy rather than reading them one by one.`,
          hunks[0].quote
        );
      } else {
        for (const h of hunks) write(hunkBody(h, cfg.user), h.quote);
      }
    } catch {
    }
  });
  app.put("/api/md", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath } = resolveFile(cfg.root, state.index, file);
    const b = await c.req.json();
    if (typeof b.content !== "string") throw new HttpError(400, "content required");
    let previous;
    try {
      previous = readFileSync3(mdPath, "utf8");
    } catch {
      previous = null;
    }
    if (b.baseVersion !== void 0) {
      if (previous === null || fileVersion(previous) !== b.baseVersion) {
        throw new HttpError(409, `${file} changed underneath you \u2014 reload`);
      }
    }
    try {
      writeFileSync2(mdPath, b.content, "utf8");
    } catch {
      throw new HttpError(500, `failed to write: ${file}`);
    }
    if (previous !== null && process.env.MDC_NO_EDIT_CAPTURE !== "1") {
      captures.note(mdPath, previous);
    }
    return c.json({ ok: true, path: file, version: fileVersion(b.content) });
  });
  app.get("/api/image", (c) => {
    const doc = requireQuery(c, "doc");
    const ref = requireQuery(c, "ref");
    const rel = resolveImage(state.imageIndex, doc, ref);
    if (rel === null) throw new HttpError(404, `image not found: ${ref}`);
    const imgPath = resolveImageFile(cfg.root, rel);
    return c.body(toBytes(readFileSync3(imgPath)), 200, {
      "content-type": contentTypeFor(imgPath)
    });
  });
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
    const docDir = posix5.dirname(doc);
    const assetsDir = docDir === "." ? "assets" : posix5.join(docDir, "assets");
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
      const targetRel = posix5.join(assetsDir, finalName);
      targetAbs = resolveWithinRoot(cfg.root, targetRel);
      try {
        writeFileSync2(targetAbs, bytes, { flag: "wx" });
        break;
      } catch (error) {
        if (error.code === "EEXIST") continue;
        throw new HttpError(500, `failed to write asset for: ${doc}`);
      }
    }
    rescan();
    const path = relative5(cfg.root, targetAbs).split(sep4).join("/");
    return c.json({ path, ref: posix5.join("assets", finalName) });
  });
  app.get("/api/image-file", (c) => {
    rescan();
    const path = requireQuery(c, "path");
    const rel = resolveIndexedImage(state.imageIndex, path);
    if (rel === null) throw new HttpError(404, `image not in index: ${path}`);
    const imgPath = resolveImageFile(cfg.root, rel);
    return c.body(toBytes(readFileSync3(imgPath)), 200, {
      "content-type": contentTypeFor(imgPath)
    });
  });
  app.get("/api/html-file", (c) => {
    rescan();
    const path = requireQuery(c, "path");
    const rel = resolveIndexedHtml(state.htmlIndex, path);
    if (rel === null) throw new HttpError(404, `html not in index: ${path}`);
    const htmlPath = resolveHtmlFile(cfg.root, rel);
    return c.body(toBytes(readFileSync3(htmlPath)), 200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"
    });
  });
  app.get("/api/pdf-file", (c) => {
    rescan();
    const path = requireQuery(c, "path");
    const rel = resolveIndexedPdf(state.pdfIndex, path);
    if (rel === null) throw new HttpError(404, `pdf not in index: ${path}`);
    const pdfPath = resolvePdfFile(cfg.root, rel);
    return c.body(toBytes(readFileSync3(pdfPath)), 200, {
      "content-type": "application/pdf"
    });
  });
  app.get("/api/drawing", (c) => {
    rescan();
    const file = requireQuery(c, "file");
    const rel = resolveIndexedDrawing(state.drawingIndex, file);
    if (rel === null) throw new HttpError(404, `drawing not in index: ${file}`);
    const drawingPath = resolveDrawingFile(cfg.root, rel);
    let content;
    try {
      content = readFileSync3(drawingPath, "utf8");
    } catch {
      throw new HttpError(404, `drawing not found on disk: ${file}`);
    }
    return c.json({
      content,
      filename: baseName(drawingPath),
      path: file,
      version: fileVersion(content)
    });
  });
  app.put("/api/drawing", async (c) => {
    rescan();
    const file = requireQuery(c, "file");
    const rel = resolveIndexedDrawing(state.drawingIndex, file);
    if (rel === null) throw new HttpError(404, `drawing not in index: ${file}`);
    const drawingPath = resolveDrawingFile(cfg.root, rel);
    const body = await c.req.json();
    if (typeof body.content !== "string") throw new HttpError(400, "content required");
    if (body.baseVersion !== void 0) {
      let current;
      try {
        current = readFileSync3(drawingPath, "utf8");
      } catch {
        current = null;
      }
      if (current === null || fileVersion(current) !== body.baseVersion) {
        throw new HttpError(409, `${file} changed underneath you \u2014 reload`);
      }
    }
    try {
      writeFileSync2(drawingPath, body.content, "utf8");
    } catch {
      throw new HttpError(500, `failed to write: ${file}`);
    }
    return c.json({ ok: true, path: file, version: fileVersion(body.content) });
  });
  app.on("HEAD", "/api/pdf-file", (c) => {
    rescan();
    const path = requireQuery(c, "path");
    const rel = resolveIndexedPdf(state.pdfIndex, path);
    if (rel === null) throw new HttpError(404, `pdf not in index: ${path}`);
    resolvePdfFile(cfg.root, rel);
    return c.body(null, 200, {
      "content-type": "application/pdf"
    });
  });
  function loadTrustedApp(appRel) {
    rescan();
    const rel = resolveIndexedHtml(state.htmlIndex, appRel);
    if (rel === null) throw new HttpError(404, `app not in index: ${appRel}`);
    const absPath = resolveHtmlFile(cfg.root, rel);
    const bytes = readFileSync3(absPath);
    if (!isTrusted(cfg.root, rel, bytes)) throw new HttpError(403, `app not trusted: ${appRel}`);
    let manifest;
    try {
      manifest = parseManifest(bytes.toString("utf8"));
    } catch (e) {
      throw new HttpError(400, e instanceof ManifestError ? e.message : "bad app manifest");
    }
    return { rel, absPath, manifest, bytes };
  }
  function readAppManifest(appRel) {
    rescan();
    const rel = resolveIndexedHtml(state.htmlIndex, appRel);
    if (rel === null) throw new HttpError(404, `app not in index: ${appRel}`);
    const absPath = resolveHtmlFile(cfg.root, rel);
    let manifest;
    try {
      manifest = parseManifest(readFileSync3(absPath, "utf8"));
    } catch (e) {
      throw new HttpError(400, e instanceof ManifestError ? e.message : "bad app manifest");
    }
    return { rel, manifest };
  }
  app.get("/api/app/info", (c) => {
    const appRel = requireQuery(c, "app");
    const { rel, manifest } = readAppManifest(appRel);
    const trusted = isTrusted(cfg.root, rel, readFileSync3(resolveHtmlFile(cfg.root, rel)));
    return c.json({
      appPath: rel,
      rootName: baseName(cfg.root),
      permissions: manifest?.permissions ?? { read: [], write: [] },
      name: manifest?.name ?? null,
      trusted
    });
  });
  app.post("/api/app/trust", async (c) => {
    const b = await c.req.json();
    if (typeof b.app !== "string" || !b.app.trim()) throw new HttpError(400, "app required");
    const { rel, manifest } = readAppManifest(b.app);
    const bytes = readFileSync3(resolveHtmlFile(cfg.root, rel));
    trustApp(cfg.root, rel, bytes);
    return c.json({
      trusted: true,
      appPath: rel,
      permissions: manifest?.permissions ?? { read: [], write: [] }
    });
  });
  app.get("/api/app/read", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const target = requireQuery(c, "path");
    if (!canRead(appRel, target, manifest)) throw new HttpError(403, `read denied: ${target}`);
    const abs = resolveWithinRoot(cfg.root, target);
    let content;
    try {
      content = readFileSync3(abs, "utf8");
    } catch {
      throw new HttpError(404, `file not found: ${target}`);
    }
    return c.json({ path: target, content, version: fileVersion(content) });
  });
  app.put("/api/app/write", async (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const target = requireQuery(c, "path");
    const body = await c.req.json();
    if (typeof body.content !== "string") throw new HttpError(400, "content required");
    if (!canWrite(appRel, target, manifest)) throw new HttpError(403, `write denied: ${target}`);
    const abs = resolveWithinRoot(cfg.root, target);
    if (body.baseVersion !== void 0) {
      let current;
      try {
        current = readFileSync3(abs, "utf8");
      } catch {
        current = null;
      }
      if (current === null || fileVersion(current) !== body.baseVersion) {
        throw new HttpError(409, `${target} changed underneath you \u2014 reload`);
      }
    }
    try {
      mkdirSync(dirname2(abs), { recursive: true });
      writeFileSync2(abs, body.content, "utf8");
    } catch {
      throw new HttpError(500, `failed to write: ${target}`);
    }
    rescan();
    return c.json({ path: target, saved: true, version: fileVersion(body.content) });
  });
  app.delete("/api/app/delete", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const target = requireQuery(c, "path");
    if (!canWrite(appRel, target, manifest)) throw new HttpError(403, `delete denied: ${target}`);
    const abs = resolveWithinRoot(cfg.root, target);
    let deleted = false;
    try {
      if (existsSync4(abs)) {
        unlinkSync(abs);
        deleted = true;
      }
      const sc = sidecarPath(abs);
      if (existsSync4(sc)) unlinkSync(sc);
    } catch {
      throw new HttpError(500, `failed to delete: ${target}`);
    }
    rescan();
    return c.json({ path: target, deleted });
  });
  app.get("/api/app/list", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const dirRel = c.req.query("path") ?? "";
    const recursive = c.req.query("recursive") === "1";
    const absDir = dirRel === "" ? cfg.root : resolveWithinRoot(cfg.root, dirRel);
    const out = [];
    if (recursive) {
      for (const [sub] of walkFiles(absDir, deny)) {
        const rel = dirRel === "" ? sub : `${dirRel}/${sub}`;
        if (canRead(appRel, rel, manifest)) out.push({ path: rel, type: "file" });
      }
    } else {
      let entries;
      try {
        entries = readdirSync2(absDir, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isDir: d.isDirectory()
        }));
      } catch {
        throw new HttpError(404, `not a directory: ${dirRel}`);
      }
      for (const e of entries) {
        const rel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
        if (canRead(appRel, rel, manifest)) {
          out.push({ path: rel, type: e.isDir ? "dir" : "file" });
        }
      }
    }
    return c.json({ path: dirRel, entries: out.sort((a, b) => a.path < b.path ? -1 : 1) });
  });
  app.get("/api/app/read-frontmatter", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    const dirRel = c.req.query("path") ?? "";
    const recursive = c.req.query("recursive") === "1";
    const absDir = dirRel === "" ? cfg.root : resolveWithinRoot(cfg.root, dirRel);
    const out = [];
    const addFile = (rel) => {
      if (!canRead(appRel, rel, manifest)) return;
      let content;
      try {
        content = readFileSync3(resolveWithinRoot(cfg.root, rel), "utf8");
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
      let entries;
      try {
        entries = readdirSync2(absDir, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isFile: d.isFile()
        }));
      } catch {
        throw new HttpError(404, `not a directory: ${dirRel}`);
      }
      for (const e of entries) {
        if (!e.isFile) continue;
        addFile(dirRel === "" ? e.name : `${dirRel}/${e.name}`);
      }
    }
    return c.json({ path: dirRel, entries: out.sort((a, b) => a.path < b.path ? -1 : 1) });
  });
  app.get("/api/app/watch", (c) => {
    const { rel: appRel, manifest } = loadTrustedApp(requireQuery(c, "app"));
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "{}" });
      let unsub = () => {
      };
      const done = new Promise((resolve3) => {
        unsub = watcher.subscribe((_kind, rel) => {
          if (!canRead(appRel, rel, manifest)) return;
          void stream.writeSSE({ event: "changed", data: "{}" });
        });
        stream.onAbort(() => {
          unsub();
          resolve3();
        });
      });
      const hb = setInterval(() => {
        void stream.writeSSE({ data: "", event: "heartbeat" });
      }, 3e4);
      await done;
      clearInterval(hb);
    });
  });
  app.get("/api/comments", (c) => {
    const file = requireQuery(c, "file");
    const { scPath } = resolveFile(cfg.root, state.index, file);
    return c.json({ entries: readSidecar(scPath) });
  });
  app.post("/api/comments", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const b = await c.req.json();
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
    const entry = {
      id: newId(),
      file: baseName(mdPath),
      anchor,
      parent_id: parentId,
      author: b.author,
      body: b.body,
      timestamp: nowIso()
    };
    appendEntry(scPath, entry);
    return c.json(entry);
  });
  app.post("/api/comments/resolve", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const a = await c.req.json();
    const entries = readSidecar(scPath);
    let prepared;
    try {
      const batch = [{
        type: "resolved",
        thread_id: a.thread_id,
        ...a.resolution === void 0 ? {} : { resolution: a.resolution },
        ...a.suggestion_id === void 0 ? {} : { suggestion_id: a.suggestion_id }
      }];
      if (a.resolution === "dismissed") {
        batch.push({ type: "unresolved", thread_id: a.thread_id });
      }
      prepared = buildEntries(
        batch,
        entries,
        baseName(mdPath),
        a.author
      );
    } catch (error) {
      if (error instanceof ValidationError) throw new HttpError(400, error.message);
      throw error;
    }
    appendEntries(scPath, prepared);
    return c.json(prepared[0]);
  });
  app.post("/api/suggestions/apply", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const body = await c.req.json();
    if (!body.thread_id || !body.suggestion_id || !body.author) {
      throw new HttpError(400, "thread_id, suggestion_id, and author required");
    }
    const entries = readSidecar(scPath);
    let decision;
    try {
      const prepared = buildEntries(
        [{
          type: "resolved",
          thread_id: body.thread_id,
          resolution: "applied",
          suggestion_id: body.suggestion_id
        }],
        entries,
        baseName(mdPath),
        body.author
      );
      decision = prepared[0];
    } catch (error) {
      if (error instanceof ValidationError) throw new HttpError(400, error.message);
      throw error;
    }
    const suggestion = entries.find((entry) => entry.id === body.suggestion_id).suggestion;
    const rawText = readFileSync3(mdPath, "utf8");
    const applied = applySuggestion(rawText, suggestion);
    if (!applied.ok) {
      throw new HttpError(409, "suggestion target no longer matches the document");
    }
    writeFileSync2(mdPath, applied.content, "utf8");
    appendEntry(scPath, decision);
    return c.json({
      content: applied.content,
      version: fileVersion(applied.content),
      entry: decision
    });
  });
  app.post("/api/comments/resolve-system", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const body = await c.req.json();
    if (!Array.isArray(body.thread_ids) || body.thread_ids.length === 0) {
      throw new HttpError(400, "thread_ids required");
    }
    const ids = body.thread_ids;
    if (!ids.every((id) => typeof id === "string" && id.length > 0)) {
      throw new HttpError(400, "thread_ids must be non-empty strings");
    }
    const entries = readSidecar(scPath);
    const topById = new Map(topLevelComments(entries).map((t) => [t.id, t]));
    const prepared = [];
    for (const id of ids) {
      const top = topById.get(id);
      if (!top) throw new HttpError(400, `thread_id ${id} not found`);
      const anchor = top.anchor ?? {};
      prepared.push({
        id: newId(),
        file: baseName(mdPath),
        type: "resolved",
        thread_id: id,
        anchor_snapshot: { quote: anchor.quote ?? "", line: anchor.line ?? null },
        author: "system",
        timestamp: nowIso()
      });
    }
    for (const entry of prepared) appendEntry(scPath, entry);
    return c.json({ resolved: prepared.map((entry) => entry.thread_id) });
  });
  app.post("/api/comments/unresolve", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const a = await c.req.json();
    const entries = readSidecar(scPath);
    if (!topLevelComments(entries).some((t) => t.id === a.thread_id)) {
      throw new HttpError(400, `thread_id ${a.thread_id} not found`);
    }
    const entry = {
      id: newId(),
      file: baseName(mdPath),
      type: "unresolved",
      thread_id: a.thread_id,
      author: a.author,
      timestamp: nowIso()
    };
    appendEntry(scPath, entry);
    return c.json(entry);
  });
  app.post("/api/comments/edit", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const a = await c.req.json();
    if (!a.body?.trim()) throw new HttpError(400, "body required");
    const entries = readSidecar(scPath);
    if (!commentIds(entries).has(a.comment_id)) {
      throw new HttpError(400, `comment_id ${a.comment_id} not found`);
    }
    const entry = {
      id: newId(),
      file: baseName(mdPath),
      type: "edit",
      comment_id: a.comment_id,
      body: a.body,
      author: a.author,
      timestamp: nowIso()
    };
    appendEntry(scPath, entry);
    return c.json(entry);
  });
  app.post("/api/comments/delete", async (c) => {
    const file = requireQuery(c, "file");
    const { mdPath, scPath } = resolveFile(cfg.root, state.index, file);
    const a = await c.req.json();
    const entries = readSidecar(scPath);
    if (!commentIds(entries).has(a.comment_id)) {
      throw new HttpError(400, `comment_id ${a.comment_id} not found`);
    }
    const entry = {
      id: newId(),
      file: baseName(mdPath),
      type: "deleted",
      comment_id: a.comment_id,
      author: a.author,
      timestamp: nowIso()
    };
    appendEntry(scPath, entry);
    const pruned = pruneIfEmpty(scPath, cfg.user);
    return c.json({ ...entry, sidecar_pruned: pruned });
  });
  app.post("/api/comments/delete-thread", async (c) => {
    const file = requireQuery(c, "file");
    const scPath = resolveSidecarPath(cfg.root, file);
    const fileName = baseName(file);
    const a = await c.req.json();
    const entries = readSidecar(scPath);
    if (!topLevelComments(entries).some((t) => t.id === a.thread_id)) {
      throw new HttpError(400, `thread_id ${a.thread_id} not found`);
    }
    const targets = /* @__PURE__ */ new Set([a.thread_id]);
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
        timestamp: ts
      });
    }
    const pruned = pruneIfEmpty(scPath, cfg.user);
    return c.json({ deleted: [...targets].sort(), sidecar_pruned: pruned });
  });
  app.delete("/api/sidecar", (c) => {
    const file = requireQuery(c, "file");
    const scPath = resolveSidecarForDelete(cfg.root, file);
    try {
      statSync2(scPath);
    } catch {
      return c.json({ deleted: false, reason: "no sidecar" });
    }
    unlinkSync(scPath);
    return c.json({ deleted: true });
  });
  app.post("/api/file", async (c) => {
    const b = await c.req.json();
    if (typeof b.path !== "string" || !b.path.trim()) throw new HttpError(400, "path required");
    const drawing = isDrawingName(b.path);
    if (!b.path.endsWith(".md") && !drawing) {
      throw new HttpError(400, "file must end in .md, .excalidraw, or .excalidraw.json");
    }
    const abs = resolveWithinRoot(cfg.root, b.path);
    if (existsSync4(abs)) throw new HttpError(409, `already exists: ${b.path}`);
    const content = drawing ? EMPTY_EXCALIDRAW_SCENE : "";
    try {
      mkdirSync(dirname2(abs), { recursive: true });
      writeFileSync2(abs, content, "utf8");
    } catch {
      throw new HttpError(500, `failed to create: ${b.path}`);
    }
    rescan();
    return c.json({ ok: true, path: b.path, content });
  });
  app.post("/api/folder", async (c) => {
    const b = await c.req.json();
    if (typeof b.path !== "string" || !b.path.trim()) throw new HttpError(400, "path required");
    const abs = resolveWithinRoot(cfg.root, b.path);
    if (existsSync4(abs)) throw new HttpError(409, `already exists: ${b.path}`);
    try {
      mkdirSync(abs, { recursive: true });
    } catch {
      throw new HttpError(500, `failed to create folder: ${b.path}`);
    }
    rescan();
    return c.json({ ok: true, path: b.path });
  });
  app.delete("/api/file", (c) => {
    const file = requireQuery(c, "file");
    const abs = resolveWithinRoot(cfg.root, file);
    let deleted = false;
    if (existsSync4(abs)) {
      unlinkSync(abs);
      deleted = true;
    }
    const sc = sidecarPath(abs);
    if (existsSync4(sc)) unlinkSync(sc);
    rescan();
    return c.json({ deleted });
  });
  app.delete("/api/folder", (c) => {
    const folder = requireQuery(c, "folder");
    const abs = resolveWithinRoot(cfg.root, folder);
    if (!existsSync4(abs)) return c.json({ deleted: false, reason: "not found" });
    if (!statSync2(abs).isDirectory()) throw new HttpError(400, `not a folder: ${folder}`);
    rmSync(abs, { recursive: true, force: true });
    rescan();
    return c.json({ deleted: true });
  });
  app.get("/api/folder/summary", (c) => {
    const folder = requireQuery(c, "folder");
    const abs = resolveWithinRoot(cfg.root, folder);
    if (!existsSync4(abs) || !statSync2(abs).isDirectory()) {
      throw new HttpError(404, `not a folder: ${folder}`);
    }
    let docs = 0;
    let withComments = 0;
    for (const [rel, name] of walkFiles(abs, deny)) {
      if (!name.endsWith(".md")) continue;
      docs++;
      const scAbs = sidecarPath(join5(abs, rel));
      if (existsSync4(scAbs) && countOpenThreads(scAbs, cfg.user) > 0) withComments++;
    }
    return c.json({ docs, withComments });
  });
  app.post("/api/move", async (c) => {
    const b = await c.req.json();
    if (typeof b.from !== "string" || !b.from.trim()) throw new HttpError(400, "from required");
    if (typeof b.to !== "string" || !b.to.trim()) throw new HttpError(400, "to required");
    const fromAbs = resolveWithinRoot(cfg.root, b.from);
    const toAbs = resolveWithinRoot(cfg.root, b.to);
    if (!existsSync4(fromAbs)) throw new HttpError(404, `not found: ${b.from}`);
    if (existsSync4(toAbs)) throw new HttpError(409, `already exists: ${b.to}`);
    if (toAbs === fromAbs || toAbs.startsWith(fromAbs + "/")) {
      throw new HttpError(400, "cannot move a path into itself");
    }
    rescan();
    const plan = planMove({ root: cfg.root, index: state.index, from: b.from, to: b.to });
    if (plan.collisions.length) {
      throw new HttpError(409, `destination collisions: ${plan.collisions.join(", ")}`);
    }
    mkdirSync(dirname2(toAbs), { recursive: true });
    renameSync(fromAbs, toAbs);
    if (!statSync2(toAbs).isDirectory()) {
      const fromSc = sidecarPath(fromAbs);
      if (existsSync4(fromSc)) renameSync(fromSc, sidecarPath(toAbs));
    }
    rescan();
    let rewrittenDocs = 0;
    let rewrittenLinks = 0;
    for (const edit of [...plan.inboundEdits, ...plan.outboundEdits]) {
      try {
        writeFileSync2(join5(cfg.root, edit.path), edit.content, "utf8");
        rewrittenDocs++;
        rewrittenLinks += edit.rewrites.length;
      } catch {
      }
    }
    rescan();
    return c.json({
      moved: { from: b.from, to: b.to },
      docsMoved: plan.fileMoves.length,
      sidecarsRelocated: plan.fileMoves.filter((m) => m.hasSidecar).length,
      docsRewritten: rewrittenDocs,
      linksRewritten: rewrittenLinks
    });
  });
  app.get("/api/move/preview", (c) => {
    const from = requireQuery(c, "from");
    const to = requireQuery(c, "to");
    resolveWithinRoot(cfg.root, from);
    resolveWithinRoot(cfg.root, to);
    if (!existsSync4(join5(cfg.root, from))) throw new HttpError(404, `not found: ${from}`);
    rescan();
    const plan = planMove({ root: cfg.root, index: state.index, from, to });
    return c.json({ from, to, ...planSummary(plan) });
  });
  app.get("/api/events", (c) => {
    const requested = c.req.queries("file") ?? [];
    const watched = /* @__PURE__ */ new Set();
    for (const f of requested) {
      if (state.index.has(f) || state.drawingIndex.has(f) || state.htmlIndex.has(f) || state.imageIndex.has(f) || state.pdfIndex.has(f)) {
        watched.add(f);
      }
    }
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "{}" });
      let unsub = () => {
      };
      const onOpen = (rel) => {
        void stream.writeSSE({ event: "open-file", data: JSON.stringify({ file: rel }) });
      };
      openListeners.add(onOpen);
      const done = new Promise((resolve3) => {
        unsub = watcher.subscribe((kind, rel) => {
          if (!watched.has(rel)) return;
          void stream.writeSSE({ event: kind, data: JSON.stringify({ file: rel }) });
        });
        stream.onAbort(() => {
          unsub();
          openListeners.delete(onOpen);
          resolve3();
        });
      });
      const hb = setInterval(() => {
        void stream.writeSSE({ data: "", event: "heartbeat" });
      }, 3e4);
      await done;
      clearInterval(hb);
    });
  });
  app.post("/api/open", async (c) => {
    const b = await c.req.json();
    const rel = String(b.file ?? "");
    if (!state.index.has(rel) && !state.drawingIndex.has(rel) && !state.imageIndex.has(rel) && !state.htmlIndex.has(rel) && !state.pdfIndex.has(rel)) {
      return c.json({ delivered: false, reason: "unknown file" }, 404);
    }
    if (openListeners.size === 0) {
      return c.json({ delivered: false, reason: "no browser tab listening" }, 409);
    }
    broadcastOpen(rel);
    return c.json({ delivered: true });
  });
  app.post("/api/handoff/open", async (c) => {
    const b = await c.req.json();
    resolveFile(cfg.root, state.index, b.file);
    const s = handoff.open(b.file);
    return c.json({ sessionId: s.sessionId, file: s.file });
  });
  app.post("/api/handoff/done", async (c) => {
    const b = await c.req.json();
    const s = handoff.get(b.sessionId);
    if (!s) return c.json({ ok: true, delivered: false });
    const delivered = s.watcherCount > 0;
    s.fire(b.intent);
    if (!delivered) handoff.recordLatch(s.file, b.intent);
    return c.json({ ok: true, delivered });
  });
  app.get("/api/handoff/events", (c) => {
    const sessionId = requireQuery(c, "sessionId");
    const s = handoff.get(sessionId);
    if (!s) throw new HttpError(404, `unknown sessionId: ${sessionId}`);
    return streamSSE(c, async (stream) => {
      s.watcherCount += 1;
      s.hadWatcher = true;
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        s.watcherCount = Math.max(0, s.watcherCount - 1);
      });
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!aborted) {
          const fired = await Promise.race([
            s.signal.then(() => true),
            sleep(2e4).then(() => false)
          ]);
          if (fired) {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ intent: s.intent, file: s.file })
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
  app.get("/assets/*", (c) => {
    const rel = c.req.path.slice("/".length);
    if (rel.includes("..")) throw new HttpError(404, "not found");
    const filePath = join5(cfg.staticDir, rel);
    let body;
    try {
      body = readFileSync3(filePath);
    } catch {
      throw new HttpError(404, `not found: ${rel}`);
    }
    return c.body(toBytes(body), 200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "public, max-age=31536000, immutable"
    });
  });
  app.get("/api/handoff/sessions", (c) => {
    const s = handoff.active();
    if (!s) return c.json({ active: null });
    return c.json({
      active: {
        sessionId: s.sessionId,
        file: s.file,
        created_at: s.createdAt / 1e3,
        // epoch seconds
        watching: s.watcherCount > 0
      }
    });
  });
  return { app, watcher };
}
function requireQuery(c, name) {
  const v = c.req.query(name);
  if (v === void 0) throw new HttpError(422, `missing query param: ${name}`);
  return v;
}
function commentIds(entries) {
  return new Set(entries.filter((e) => !isEvent(e)).map((e) => e.id));
}
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function toBytes(buf) {
  const ab = new ArrayBuffer(buf.byteLength);
  const out = new Uint8Array(ab);
  out.set(buf);
  return out;
}
var CONTENT_TYPES = {
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
  ".woff2": "font/woff2"
};
function contentTypeFor(path) {
  const i = path.lastIndexOf(".");
  const ext = i < 0 ? "" : path.slice(i).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// src/server/serve.ts
function resolveStaticDir(override) {
  const explicit = override ?? process.env.MDC_STATIC_DIR;
  if (explicit) {
    const dir2 = resolve2(explicit);
    if (existsSync5(join6(dir2, "index.html"))) return dir2;
    throw new Error(`no index.html in static dir: ${dir2}`);
  }
  let dir = dirname3(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join6(dir, "web", "dist", "index.html");
    if (existsSync5(candidate)) return join6(dir, "web", "dist");
    const parent = dirname3(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "could not locate the built frontend (web/dist) \u2014 run `npm run build:web`, or set MDC_STATIC_DIR / pass --static-dir"
  );
}
function printStartupBanner(args) {
  console.log(`user: ${args.user}`);
  console.log(`Root:    ${args.root}`);
  console.log(`Deny:    [${[...args.deny].sort().map((d) => `'${d}'`).join(", ")}]`);
  console.log(`Indexed: ${args.markdownCount} markdown file(s), ${args.imageCount} image(s)`);
  console.log(`URL:     http://localhost:${args.port}`);
  if (args.identitySource === "default") {
    console.log('tip: comments are attributed as "user" \u2014 set your name: mdc identity <name>');
  }
}
async function startServer(rootArg, opts) {
  const root = resolve2(rootArg);
  if (!existsSync5(root) || !statSync3(root).isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }
  const staticDir = resolveStaticDir(opts.staticDir);
  const identity = currentUserWithSource(root);
  const user = identity.name;
  const deny = denyFrom(opts.deny);
  const index = buildIndex(root, deny);
  const imageIndex = buildImageIndex(root, deny);
  const { app, watcher } = createApp({ root, staticDir, denyRaw: opts.deny, user });
  printStartupBanner({
    user,
    identitySource: identity.source,
    root,
    deny,
    markdownCount: index.size,
    imageCount: imageIndex.size,
    port: opts.port
  });
  const server = honoServe({
    fetch: app.fetch,
    port: opts.port,
    hostname: "127.0.0.1"
  });
  return {
    port: opts.port,
    async close() {
      await watcher.close();
      await new Promise(
        (res, rej) => server.close((err) => err ? rej(err) : res())
      );
    }
  };
}
export {
  printStartupBanner,
  startServer
};
