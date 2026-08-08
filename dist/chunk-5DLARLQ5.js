var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/sidecar.ts
import { randomBytes } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync
} from "fs";
import { basename, dirname, join } from "path";

// src/threads.ts
var RESOLVE_TYPES = /* @__PURE__ */ new Set(["resolved", "unresolved"]);
var LIFECYCLE_TYPES = /* @__PURE__ */ new Set(["resolved", "unresolved", "acknowledged"]);
var EVENT_TYPES = /* @__PURE__ */ new Set([
  "resolved",
  "unresolved",
  "acknowledged",
  "edit",
  "deleted"
]);
function isEvent(entry) {
  return entry.type !== void 0 && EVENT_TYPES.has(entry.type);
}
function topLevelComments(entries) {
  return entries.filter((e) => !isEvent(e) && (e.parent_id ?? null) === null);
}
function deletedCommentIds(entries) {
  const ids = /* @__PURE__ */ new Set();
  for (const e of entries) {
    if (e.type === "deleted" && e.comment_id) ids.add(e.comment_id);
  }
  return ids;
}
function decidedSuggestions(entries) {
  const decided = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type === "resolved" && entry.suggestion_id && (entry.resolution === "applied" || entry.resolution === "dismissed")) {
      decided.set(entry.suggestion_id, entry.resolution);
    }
  }
  return decided;
}
function actionableSuggestion(entries, threadId) {
  const deleted = deletedCommentIds(entries);
  const decided = decidedSuggestions(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isEvent(entry) && entry.suggestion !== void 0 && !deleted.has(entry.id) && (entry.id === threadId || entry.parent_id === threadId)) {
      return decided.has(entry.id) ? void 0 : entry;
    }
  }
  return void 0;
}
function threadSuggestionState(entries, threadId) {
  const ids = new Set(
    entries.filter(
      (entry) => entry.suggestion !== void 0 && (entry.id === threadId || entry.parent_id === threadId)
    ).map((entry) => entry.id)
  );
  return {
    actionable: actionableSuggestion(entries, threadId)?.id ?? null,
    decided: Object.fromEntries(
      [...decidedSuggestions(entries)].filter(([suggestionId]) => ids.has(suggestionId))
    )
  };
}
function latestBodyByComment(entries) {
  const latest = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (e.type === "edit" && e.comment_id) latest.set(e.comment_id, e.body ?? "");
  }
  return latest;
}
function resolvedThreadIds(entries) {
  const latest = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (e.type !== void 0 && RESOLVE_TYPES.has(e.type) && e.thread_id !== void 0) {
      latest.set(e.thread_id, e.type);
    }
  }
  const out = /* @__PURE__ */ new Set();
  for (const [tid, t] of latest) if (t === "resolved") out.add(tid);
  return out;
}
function threadStatusMap(entries) {
  const status = /* @__PURE__ */ new Map();
  const everAcked = /* @__PURE__ */ new Set();
  for (const e of entries) {
    const t = e.type;
    if (t === void 0 || !LIFECYCLE_TYPES.has(t)) continue;
    const tid = e.thread_id;
    if (!tid) continue;
    if (t === "acknowledged") {
      everAcked.add(tid);
      status.set(tid, "acknowledged");
    } else if (t === "resolved") {
      status.set(tid, "resolved");
    } else if (t === "unresolved") {
      status.set(tid, everAcked.has(tid) ? "acknowledged" : "pending");
    }
  }
  return status;
}
function survivingRepliesByParent(entries, deleted) {
  const byParent = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (!isEvent(e) && (e.parent_id ?? null) !== null && !deleted.has(e.id)) {
      const parentId = e.parent_id;
      const list = byParent.get(parentId);
      if (list) list.push(e);
      else byParent.set(parentId, [e]);
    }
  }
  return byParent;
}
function deriveThreads(entries, user) {
  const resolved = resolvedThreadIds(entries);
  const deleted = deletedCommentIds(entries);
  const lifecycleMap = threadStatusMap(entries);
  const byParent = survivingRepliesByParent(entries, deleted);
  const threads = [];
  for (const top of topLevelComments(entries)) {
    const replies = [...byParent.get(top.id) ?? []].sort(
      (a, b) => (a.timestamp ?? "") < (b.timestamp ?? "") ? -1 : (a.timestamp ?? "") > (b.timestamp ?? "") ? 1 : 0
    );
    if (deleted.has(top.id) && replies.length === 0) {
      continue;
    }
    const full = [top, ...replies];
    const survivingIds = new Set(full.map((entry) => entry.id));
    let last = top;
    for (const entry of entries) {
      const isSurvivingContent = !isEvent(entry) && survivingIds.has(entry.id);
      const isSuggestionDecision = entry.type === "resolved" && entry.thread_id === top.id && entry.suggestion_id !== void 0 && (entry.resolution === "applied" || entry.resolution === "dismissed");
      if (isSurvivingContent || isSuggestionDecision) last = entry;
    }
    const anchor = top.anchor ?? {};
    const isResolved = resolved.has(top.id);
    let lifecycle;
    if (isResolved) {
      lifecycle = "resolved";
    } else {
      lifecycle = lifecycleMap.get(top.id) ?? "pending";
      if (lifecycle === "resolved") lifecycle = "pending";
    }
    threads.push({
      thread_id: top.id,
      quote: anchor.quote ?? "",
      status: isResolved ? "resolved" : "open",
      awaiting: last.author === user ? "agent" : "you",
      last_author: last.author ?? null,
      last_ts: last.timestamp ?? null,
      reply_count: replies.length,
      lifecycle
    });
  }
  return threads;
}
function openThreadsAwaitingAgent(entries, user) {
  return deriveThreads(entries, user).filter(
    (t) => t.status !== "resolved" && t.awaiting === "agent"
  );
}

// src/sidecar.ts
var SIDECAR_SUFFIX = ".comments.jsonl";
var ValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
};
function sidecarPathFor(mdPath) {
  return join(dirname(mdPath), basename(mdPath) + SIDECAR_SUFFIX);
}
function mdPathFor(sidecarPath) {
  const name = basename(sidecarPath);
  if (!name.endsWith(SIDECAR_SUFFIX)) {
    throw new Error(`not a sidecar filename: ${name}`);
  }
  return join(dirname(sidecarPath), name.slice(0, -SIDECAR_SUFFIX.length));
}
function readSidecar(sidecarPath) {
  if (!existsSync(sidecarPath)) return [];
  const entries = [];
  for (const raw of readFileSync(sidecarPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (line) entries.push(JSON.parse(line));
  }
  return entries;
}
function appendEntries(sidecarPath, entries) {
  mkdirSync(dirname(sidecarPath), { recursive: true });
  const payload = entries.map((e) => JSON.stringify(e) + "\n").join("");
  appendFileSync(sidecarPath, payload);
}
function appendEntry(sidecarPath, entry) {
  appendEntries(sidecarPath, [entry]);
}
function countOpenThreads(sidecarPath, user) {
  return openThreadsAwaitingAgent(readSidecar(sidecarPath), user).length;
}
function pruneIfEmpty(sidecarPath, user) {
  if (!existsSync(sidecarPath)) return false;
  if (deriveThreads(readSidecar(sidecarPath), user).length > 0) return false;
  unlinkSync(sidecarPath);
  return true;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId() {
  return randomBytes(6).toString("hex");
}
function validateSuggestion(value, entryIndex) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`entry ${entryIndex}: suggestion must be an object`);
  }
  const suggestion = value;
  const targetValue = suggestion.target;
  if (typeof targetValue !== "object" || targetValue === null || Array.isArray(targetValue)) {
    throw new ValidationError(`entry ${entryIndex}: suggestion.target must be an object`);
  }
  const target = targetValue;
  if (typeof target.quote !== "string" || !target.quote) {
    throw new ValidationError(`entry ${entryIndex}: suggestion.target.quote must be non-empty string`);
  }
  const contextValue = target.context;
  if (typeof contextValue !== "object" || contextValue === null || Array.isArray(contextValue)) {
    throw new ValidationError(`entry ${entryIndex}: suggestion.target.context must be an object`);
  }
  const context = contextValue;
  for (const key of ["before", "after"]) {
    if (!(key in context) || typeof context[key] !== "string") {
      throw new ValidationError(
        `entry ${entryIndex}: suggestion.target.context.${key} must be a string`
      );
    }
  }
  if (typeof suggestion.replacement !== "string") {
    throw new ValidationError(`entry ${entryIndex}: suggestion.replacement must be a string`);
  }
  return {
    target: {
      quote: target.quote,
      context: { before: context.before, after: context.after }
    },
    replacement: suggestion.replacement
  };
}
function buildEntries(batch, existing, fileName, author) {
  if (!Array.isArray(batch)) {
    throw new ValidationError("batch must be a JSON array");
  }
  if (batch.length === 0) {
    throw new ValidationError("batch is empty \u2014 nothing to append");
  }
  const existingIds = new Set(existing.map((e) => e.id));
  const commentIds = new Set(
    existing.filter((e) => !(e.type !== void 0 && EVENT_TYPES.has(e.type))).map((e) => e.id)
  );
  const topLevelById = /* @__PURE__ */ new Map();
  for (const e of existing) {
    if (!(e.type !== void 0 && EVENT_TYPES.has(e.type)) && (e.parent_id ?? null) === null) {
      topLevelById.set(e.id, e);
    }
  }
  const prepared = [];
  for (let i = 0; i < batch.length; i++) {
    const e = batch[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      throw new ValidationError(`entry ${i}: must be an object`);
    }
    const entry = e;
    const etype = entry.type;
    if (etype !== void 0 && etype !== null && "suggestion" in entry) {
      throw new ValidationError(`entry ${i}: suggestion is only valid on a comment or reply`);
    }
    if (etype === "resolved" || etype === "unresolved" || etype === "acknowledged") {
      const threadId = entry.thread_id;
      if (typeof threadId !== "string" || !threadId) {
        throw new ValidationError(`entry ${i}: ${etype} must have a non-empty thread_id`);
      }
      const top = topLevelById.get(threadId);
      if (!top) {
        throw new ValidationError(
          `entry ${i}: thread_id '${threadId}' is not a top-level comment in sidecar`
        );
      }
      const event = {
        id: newId(),
        file: fileName,
        type: etype,
        thread_id: threadId,
        author,
        timestamp: nowIso()
      };
      if (etype === "resolved") {
        const hasResolution = entry.resolution !== void 0;
        const hasSuggestionId = entry.suggestion_id !== void 0;
        if (hasResolution !== hasSuggestionId) {
          throw new ValidationError(
            `entry ${i}: resolved suggestion decisions require resolution and suggestion_id`
          );
        }
        if (hasResolution) {
          const resolution = entry.resolution;
          const suggestionId = entry.suggestion_id;
          if (resolution !== "applied" && resolution !== "dismissed") {
            throw new ValidationError(
              `entry ${i}: resolution must be 'applied' or 'dismissed'`
            );
          }
          if (typeof suggestionId !== "string" || !suggestionId) {
            throw new ValidationError(`entry ${i}: suggestion_id must be a non-empty string`);
          }
          const allKnown = [...existing, ...prepared];
          const deleted = deletedCommentIds(allKnown);
          const suggestionEntry = allKnown.find((candidate) => candidate.id === suggestionId);
          const belongsToThread = suggestionEntry?.id === threadId || suggestionEntry?.parent_id === threadId;
          if (!suggestionEntry || isEvent(suggestionEntry) || !suggestionEntry.suggestion || deleted.has(suggestionId) || !belongsToThread) {
            throw new ValidationError(
              `entry ${i}: suggestion_id '${suggestionId}' is not a surviving suggestion in thread '${threadId}'`
            );
          }
          if (decidedSuggestions(allKnown).has(suggestionId)) {
            throw new ValidationError(
              `entry ${i}: suggestion_id '${suggestionId}' is already decided`
            );
          }
          if (actionableSuggestion(allKnown, threadId)?.id !== suggestionId) {
            throw new ValidationError(
              `entry ${i}: suggestion_id '${suggestionId}' is not the actionable suggestion in thread '${threadId}'`
            );
          }
          event.resolution = resolution;
          event.suggestion_id = suggestionId;
        }
        const anchor2 = top.anchor ?? {};
        event.anchor_snapshot = {
          quote: anchor2.quote ?? "",
          line: anchor2.line ?? null
        };
      }
      prepared.push(event);
      continue;
    }
    if (etype === "edit" || etype === "deleted") {
      const commentId = entry.comment_id;
      if (typeof commentId !== "string" || !commentId) {
        throw new ValidationError(`entry ${i}: ${etype} must have a non-empty comment_id`);
      }
      if (!commentIds.has(commentId)) {
        throw new ValidationError(
          `entry ${i}: comment_id '${commentId}' is not a comment or reply in sidecar`
        );
      }
      const event = {
        id: newId(),
        file: fileName,
        type: etype,
        comment_id: commentId,
        author,
        timestamp: nowIso()
      };
      if (etype === "edit") {
        const ebody = entry.body ?? "";
        if (typeof ebody !== "string" || !ebody.trim()) {
          throw new ValidationError(`entry ${i}: edit must have a non-empty body`);
        }
        event.body = ebody;
      }
      prepared.push(event);
      continue;
    }
    if (etype !== void 0 && etype !== null) {
      throw new ValidationError(`entry ${i}: unknown type '${String(etype)}'`);
    }
    const body = entry.body ?? "";
    if (typeof body !== "string" || !body.trim()) {
      throw new ValidationError(`entry ${i}: body must be a non-empty string`);
    }
    const parentId = entry.parent_id ?? null;
    const anchor = entry.anchor ?? null;
    const suggestion = "suggestion" in entry ? validateSuggestion(entry.suggestion, i) : void 0;
    if (parentId === null && anchor === null) {
      throw new ValidationError(
        `entry ${i}: must have either parent_id (reply) or anchor (top-level)`
      );
    }
    if (parentId !== null && anchor !== null) {
      throw new ValidationError(`entry ${i}: cannot have both parent_id and anchor`);
    }
    if (parentId !== null) {
      if (!existingIds.has(parentId)) {
        throw new ValidationError(`entry ${i}: parent_id '${parentId}' not found in sidecar`);
      }
    } else {
      if (typeof anchor !== "object" || anchor === null || Array.isArray(anchor)) {
        throw new ValidationError(`entry ${i}: anchor must be an object`);
      }
      if (!("quote" in anchor)) {
        throw new ValidationError(`entry ${i}: anchor missing key 'quote'`);
      }
      if (typeof anchor.quote !== "string" || !anchor.quote) {
        throw new ValidationError(`entry ${i}: anchor.quote must be non-empty string`);
      }
      const ctx = anchor.context ?? null;
      if (ctx !== null) {
        if (typeof ctx !== "object" || Array.isArray(ctx)) {
          throw new ValidationError(`entry ${i}: anchor.context must be an object`);
        }
        for (const k of ["before", "after"]) {
          if (k in ctx && typeof ctx[k] !== "string") {
            throw new ValidationError(`entry ${i}: anchor.context.${k} must be a string`);
          }
        }
      }
    }
    const content = {
      id: newId(),
      file: fileName,
      anchor,
      parent_id: parentId,
      author,
      body,
      timestamp: nowIso()
    };
    if (suggestion !== void 0) content.suggestion = suggestion;
    prepared.push(content);
  }
  return prepared;
}

// src/identity.ts
import { readFileSync as readFileSync2 } from "fs";
import { homedir } from "os";
import { join as join2 } from "path";
import { parse as parseToml } from "smol-toml";
var DEFAULT_USER = "user";
var CONFIG_FILENAME = ".mdc.toml";
function readConfigUser(root) {
  let text;
  try {
    text = readFileSync2(join2(root, CONFIG_FILENAME), "utf8");
  } catch {
    return null;
  }
  let data;
  try {
    data = parseToml(text);
  } catch {
    return null;
  }
  const user = data.user;
  return typeof user === "string" && user ? user : null;
}
function currentUser(root, deps = {}) {
  return currentUserWithSource(root, deps).name;
}
function currentUserWithSource(root, deps = {}) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const fromEnv = env.MDC_USER;
  if (fromEnv) return { name: fromEnv, source: "env" };
  const fromHome = readConfigUser(home);
  if (fromHome) return { name: fromHome, source: "home" };
  if (root != null) {
    const fromRoot = readConfigUser(root);
    if (fromRoot) return { name: fromRoot, source: "root" };
  }
  return { name: DEFAULT_USER, source: "default" };
}
function homeConfigPath(deps = {}) {
  return join2(deps.home ?? homedir(), CONFIG_FILENAME);
}

// src/anchor.ts
var LEGACY_DRIFT_CEILING = 25;
function allIndexesOf(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}
function captureContext(full, at, quote) {
  const MAX_CONTEXT = 40;
  if (at < 0 || full.slice(at, at + quote.length) !== quote) return void 0;
  for (let span = 1; span <= MAX_CONTEXT; span++) {
    const before = full.slice(Math.max(0, at - span), at);
    const after = full.slice(at + quote.length, at + quote.length + span);
    if (allIndexesOf(full, before + quote + after).length === 1) {
      return { before, after };
    }
  }
  return {
    before: full.slice(Math.max(0, at - MAX_CONTEXT), at),
    after: full.slice(at + quote.length, at + quote.length + MAX_CONTEXT)
  };
}
function lineOfOffset(text, offset) {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}
function stripInlineMd(s) {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|[^*])\*([^*]+)\*/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/(^|[^_])_([^_]+)_/g, "$1$2");
}
var MD_STRIP_PATTERNS = [
  // Line-leading BLOCK markers first (checkbox before plain list — it's a
  // superset). Rendered text never contains them, and a quote that spans two
  // blocks joins them with just a newline — so the raw side must drop the
  // next block's marker prefix for the join to line up. No capture group =
  // pure deletion.
  [/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, 0],
  [/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, 0],
  [/^[ \t]*#{1,6}[ \t]+/gm, 0],
  [/^[ \t]*>[ \t]?/gm, 0],
  // Inline markers. \n excluded everywhere: an inline span never crosses a
  // line here, and a multi-line class would pair a lone marker (the _ in a
  // snake_case word) with an unrelated one far down the doc, mangling
  // everything between.
  [/\[([^\]\n]+)\]\([^)\n]*\)/g, 1],
  // [text](url) → text
  [/\*\*([^*\n]+)\*\*/g, 2],
  [/(?<!\*)\*([^*\n]+)\*/g, 1],
  [/`([^`\n]+)`/g, 1],
  [/(?<!_)_([^_\n]+)_/g, 1]
];
function replaceMapped(s, re, prefixLen) {
  let out = "";
  const map = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    const start = m.index;
    for (let i = last; i < start; i++) {
      map.push(i);
      out += s[i];
    }
    const kept = m[1] ?? "";
    for (let i = 0; i < kept.length; i++) {
      map.push(start + prefixLen + i);
      out += kept[i];
    }
    last = start + m[0].length;
  }
  for (let i = last; i < s.length; i++) {
    map.push(i);
    out += s[i];
  }
  map.push(s.length);
  return { text: out, map };
}
function stripMdMapped(s) {
  let text = s;
  let map = null;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const [re, prefixLen] of MD_STRIP_PATTERNS) {
      const r = replaceMapped(text, re, prefixLen);
      if (r.text === text) continue;
      changed = true;
      const prev = map;
      map = prev === null ? r.map : r.map.map((idx) => prev[idx]);
      text = r.text;
    }
    if (!changed) break;
  }
  if (map === null) map = Array.from({ length: s.length + 1 }, (_, i) => i);
  return { text, map };
}
function collapseWs(s) {
  let out = "";
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const isSpace = /\s/.test(s[i]);
    if (isSpace) {
      if (prevSpace) continue;
      map.push(i);
      out += " ";
      prevSpace = true;
    } else {
      map.push(i);
      out += s[i];
      prevSpace = false;
    }
  }
  map.push(s.length);
  return { text: out, map };
}
function fuzzyFind(fullText, quote) {
  const { text: ftNorm, map } = collapseWs(fullText);
  for (const candidate of [quote, stripInlineMd(quote)]) {
    const qNorm = collapseWs(candidate).text.trim();
    if (!qNorm) continue;
    const hits = allIndexesOf(ftNorm, qNorm);
    if (hits.length !== 1) continue;
    const startIdx = map[hits[0]];
    const endIdx = map[hits[0] + qNorm.length];
    if (startIdx == null || endIdx == null || endIdx <= startIdx) continue;
    return { startIdx, length: endIdx - startIdx, recovered: true };
  }
  return null;
}
function matchByContext(anchor, fullText) {
  const q = anchor.quote;
  const before = anchor.context?.before ?? "";
  const after = anchor.context?.after ?? "";
  const fingerprint = before + q + after;
  const exact = allIndexesOf(fullText, fingerprint);
  if (exact.length === 1) {
    const startIdx = exact[0] + before.length;
    return { startIdx, length: q.length, recovered: false };
  }
  if (exact.length > 1) return null;
  const { text: ftNorm, map } = collapseWs(fullText);
  const fpNorm = collapseWs(fingerprint).text.trim();
  if (!fpNorm) return null;
  const hits = allIndexesOf(ftNorm, fpNorm);
  if (hits.length !== 1) return null;
  const fpStart = map[hits[0]];
  const fpEnd = map[hits[0] + fpNorm.length];
  if (fpStart == null || fpEnd == null || fpEnd <= fpStart) return null;
  const span = fullText.slice(fpStart, fpEnd);
  const { text: spanNorm, map: spanMap } = collapseWs(span);
  const qNorm = collapseWs(q).text.trim();
  if (!qNorm) return null;
  const within = allIndexesOf(spanNorm, qNorm);
  if (within.length !== 1) return null;
  const qStart = spanMap[within[0]];
  const qEnd = spanMap[within[0] + qNorm.length];
  if (qStart == null || qEnd == null || qEnd <= qStart) return null;
  return { startIdx: fpStart + qStart, length: qEnd - qStart, recovered: true };
}
function findTargetStrict(anchor, fullText) {
  const quote = anchor.quote;
  if (!quote || !anchor.context) return null;
  const before = anchor.context.before ?? "";
  const after = anchor.context.after ?? "";
  const fingerprint = before + quote + after;
  const exact = allIndexesOf(fullText, fingerprint);
  if (exact.length !== 1) return null;
  return {
    startIdx: exact[0] + before.length,
    length: quote.length,
    recovered: false
  };
}
function findAnchorMatch(anchor, fullText, opts = {}) {
  const direct = matchInText(anchor, fullText, opts);
  if (direct) return direct;
  const { text: stripped, map } = stripMdMapped(fullText);
  if (stripped === fullText) return null;
  const m = matchInText(anchor, stripped, opts);
  if (!m || m.length === 0) return null;
  const startIdx = map[m.startIdx];
  const lastIdx = map[m.startIdx + m.length - 1];
  if (startIdx == null || lastIdx == null || lastIdx < startIdx) return null;
  return { startIdx, length: lastIdx + 1 - startIdx, recovered: true };
}
function matchInText(anchor, fullText, opts = {}) {
  const q = anchor.quote;
  if (!q) return null;
  if (anchor.context && (anchor.context.before || anchor.context.after)) {
    return matchByContext(anchor, fullText);
  }
  const exact = allIndexesOf(fullText, q);
  if (exact.length === 1) {
    return { startIdx: exact[0], length: q.length, recovered: false };
  }
  if (exact.length > 1) {
    if (typeof anchor.line !== "number") {
      return { startIdx: exact[0], length: q.length, recovered: false };
    }
    const lineOf = opts.lineOf ?? lineOfOffset;
    let best = exact[0];
    let bestDelta = Infinity;
    for (const idx of exact) {
      const delta = Math.abs(lineOf(fullText, idx) - anchor.line);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = idx;
      }
    }
    if (bestDelta > LEGACY_DRIFT_CEILING) return null;
    return { startIdx: best, length: q.length, recovered: false };
  }
  return fuzzyFind(fullText, q);
}

// src/suggest.ts
function applySuggestion(rawText, suggestion) {
  const match = findTargetStrict(suggestion.target, rawText);
  if (!match) return { ok: false, reason: "target-not-found" };
  return {
    ok: true,
    content: rawText.slice(0, match.startIdx) + suggestion.replacement + rawText.slice(match.startIdx + match.length)
  };
}

// src/handoff.ts
var handoff_exports = {};
__export(handoff_exports, {
  HandoffError: () => HandoffError,
  normalizeIntent: () => normalizeIntent,
  openSession: () => openSession,
  waitForDone: () => waitForDone,
  waitForSignal: () => waitForSignal
});

// src/server-client.ts
var server_client_exports = {};
__export(server_client_exports, {
  DEFAULT_BASE_URL: () => DEFAULT_BASE_URL,
  activeSession: () => activeSession,
  pendingFor: () => pendingFor,
  probeServer: () => probeServer,
  serverAlive: () => serverAlive,
  serverIndex: () => serverIndex,
  serverTabConnected: () => serverTabConnected
});
import { dirname as dirname2, resolve as resolvePath } from "path";
var DEFAULT_BASE_URL = process.env.MDC_BASE_URL ?? "http://localhost:8000";
async function activeSession(baseUrl = DEFAULT_BASE_URL) {
  try {
    const r = await fetch(`${baseUrl}/api/handoff/sessions`, {
      signal: AbortSignal.timeout(5e3)
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.active ?? null;
  } catch {
    return null;
  }
}
async function serverAlive(baseUrl = DEFAULT_BASE_URL) {
  try {
    const r = await fetch(`${baseUrl}/api/index`, { signal: AbortSignal.timeout(2e3) });
    return r.status === 200;
  } catch {
    return false;
  }
}
async function serverTabConnected(baseUrl = DEFAULT_BASE_URL) {
  try {
    const r = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(2e3) });
    if (!r.ok) return false;
    const data = await r.json();
    return data.tabConnected === true;
  } catch {
    return false;
  }
}
async function serverIndex(baseUrl = DEFAULT_BASE_URL) {
  try {
    const r = await fetch(`${baseUrl}/api/index`, { signal: AbortSignal.timeout(2e3) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
async function probeServer(baseUrl = DEFAULT_BASE_URL) {
  let payload;
  try {
    const r = await fetch(`${baseUrl}/api/index`, { signal: AbortSignal.timeout(2e3) });
    if (!r.ok) return { kind: "foreign" };
    payload = await r.json();
  } catch {
    return { kind: "free" };
  }
  if (payload && typeof payload === "object" && typeof payload.root === "string" && Array.isArray(payload.files)) {
    return { kind: "mdc", root: payload.root };
  }
  return { kind: "foreign" };
}
async function pendingFor(fileRel, baseUrl) {
  const index = await serverIndex(baseUrl);
  const root = index?.root;
  if (typeof root !== "string" || !root) return [];
  const mdPath = resolvePath(root, fileRel);
  const entries = readSidecar(sidecarPathFor(mdPath));
  return openThreadsAwaitingAgent(entries, currentUser(dirname2(mdPath))).map((thread) => ({
    ...thread,
    suggestion_state: threadSuggestionState(entries, thread.thread_id)
  }));
}

// src/handoff.ts
var HandoffError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "HandoffError";
  }
};
async function openSession(file, baseUrl = DEFAULT_BASE_URL) {
  const r = await fetch(`${baseUrl}/api/handoff/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file })
  });
  if (r.status === 409) {
    throw new HandoffError(`another session is already live: ${await r.text()}`);
  }
  if (r.status !== 200) {
    throw new HandoffError(`open failed (${r.status}): ${await r.text()}`);
  }
  const data = await r.json();
  return { sessionId: data.sessionId, file: data.file, baseUrl };
}
async function waitForDone(session, reconnectMax = 5, timeoutMs) {
  const deadline = timeoutMs === void 0 ? void 0 : Date.now() + timeoutMs;
  let attempts = 0;
  for (; ; ) {
    try {
      return await streamUntilDone(session, deadline);
    } catch (e) {
      if (e instanceof HandoffError) throw e;
      attempts += 1;
      if (attempts > reconnectMax) {
        throw new HandoffError(`SSE stream failed after ${attempts} attempts: ${String(e)}`);
      }
      await sleep(Math.min(2 ** attempts, 10) * 1e3);
    }
  }
}
async function streamUntilDone(session, deadline) {
  const ctrl = new AbortController();
  let timer;
  let timedOut = false;
  if (deadline !== void 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, remaining);
  }
  try {
    return await streamEvents(session, ctrl.signal);
  } catch (e) {
    if (timedOut) return "timeout";
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function streamEvents(session, signal) {
  const url = new URL(`${session.baseUrl}/api/handoff/events`);
  url.searchParams.set("sessionId", session.sessionId);
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`events stream failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = null;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) {
        event = null;
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:") && event === "done") {
        const data = line.slice("data:".length).trim();
        const payload = data ? JSON.parse(data) : {};
        void reader.cancel().catch(() => {
        });
        return payload.intent ?? "";
      }
    }
  }
  throw new HandoffError("SSE stream closed without a done event");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
var INTENT_ALIASES = { "mdc-review": "review" };
function normalizeIntent(intent) {
  if (intent === null) return null;
  return INTENT_ALIASES[intent] ?? intent;
}
async function waitForSignal(fileRel, baseUrl, timeoutMs) {
  try {
    const session = await openSession(fileRel, baseUrl);
    const intent = await waitForDone(session, void 0, timeoutMs);
    return normalizeIntent(intent);
  } catch (e) {
    if (e instanceof HandoffError) return null;
    throw e;
  }
}

// src/index.ts
var VERSION = true ? "0.8.0" : "0.0.0-dev";

export {
  LEGACY_DRIFT_CEILING,
  allIndexesOf,
  captureContext,
  lineOfOffset,
  stripInlineMd,
  stripMdMapped,
  collapseWs,
  fuzzyFind,
  findTargetStrict,
  findAnchorMatch,
  RESOLVE_TYPES,
  LIFECYCLE_TYPES,
  EVENT_TYPES,
  isEvent,
  topLevelComments,
  deletedCommentIds,
  decidedSuggestions,
  actionableSuggestion,
  threadSuggestionState,
  latestBodyByComment,
  resolvedThreadIds,
  threadStatusMap,
  survivingRepliesByParent,
  deriveThreads,
  openThreadsAwaitingAgent,
  SIDECAR_SUFFIX,
  ValidationError,
  sidecarPathFor,
  mdPathFor,
  readSidecar,
  appendEntries,
  appendEntry,
  countOpenThreads,
  pruneIfEmpty,
  nowIso,
  newId,
  buildEntries,
  DEFAULT_USER,
  CONFIG_FILENAME,
  currentUser,
  currentUserWithSource,
  homeConfigPath,
  applySuggestion,
  serverAlive,
  serverTabConnected,
  serverIndex,
  probeServer,
  pendingFor,
  server_client_exports,
  waitForSignal,
  handoff_exports,
  VERSION
};
