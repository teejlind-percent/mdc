/**
 * Thread derivation over a doc's comment entries — the pure, dependency-free
 * half of the sidecar model. Everything here is computed from an in-memory
 * `Entry[]`; nothing here touches the filesystem, so it bundles into the browser
 * as well as running server-side. The file I/O that produces those entries lives
 * in `sidecar.ts`, which re-exports this module so existing imports keep working.
 *
 * Model (append-only, derive-on-read):
 *   - A *comment* or *reply* line has no `type` field. Top-level comments carry
 *     an `anchor`; replies carry a `parent_id`.
 *   - An *event* line carries a `type`:
 *       resolved / unresolved  — act on a thread (thread_id)
 *       acknowledged           — act on a thread (thread_id)
 *       edit / deleted         — act on one comment/reply (comment_id)
 *   - "Latest event wins": a thread's status / a comment's body is whatever the
 *     last relevant event says.
 *
 * Status lifecycle (derived, per thread):
 *   pending      -> no acknowledged/resolved events
 *   acknowledged -> latest lifecycle event is `acknowledged`
 *   resolved     -> latest resolve event is `resolved`
 *   (unresolve flips a thread back; its lifecycle status falls to
 *    acknowledged if it was ever acknowledged, else pending.)
 */
declare const RESOLVE_TYPES: Set<string>;
declare const LIFECYCLE_TYPES: Set<string>;
declare const EVENT_TYPES: Set<string>;
interface AnchorContext {
    before?: string;
    after?: string;
}
interface Anchor {
    quote: string;
    line?: number | null;
    context?: AnchorContext | null;
    [key: string]: unknown;
}
interface Suggestion {
    target: {
        quote: string;
        context: {
            before: string;
            after: string;
        };
    };
    replacement: string;
}
type SuggestionResolution = "applied" | "dismissed";
/** One JSONL line: a comment, a reply, or an event. */
interface Entry {
    id: string;
    file?: string;
    type?: string;
    parent_id?: string | null;
    anchor?: Anchor | null;
    author?: string;
    body?: string;
    timestamp?: string;
    thread_id?: string;
    comment_id?: string;
    anchor_snapshot?: {
        quote: string;
        line?: number | null;
    };
    suggestion?: Suggestion;
    resolution?: SuggestionResolution;
    suggestion_id?: string;
    [key: string]: unknown;
}
type ThreadStatus = "open" | "resolved";
type Awaiting = "you" | "agent";
type Lifecycle = "pending" | "acknowledged" | "resolved";
interface Thread {
    thread_id: string;
    quote: string;
    /** The BINARY open/resolved contract the frontend + dashboard depend on. */
    status: ThreadStatus;
    awaiting: Awaiting;
    last_author: string | null;
    last_ts: string | null;
    reply_count: number;
    /** Finer pending/acknowledged/resolved state for the watch-loop; additive,
     * never redefines `status`. */
    lifecycle: Lifecycle;
}
declare function isEvent(entry: Entry): boolean;
/**
 * Top-level comments only — excludes replies (parent_id set) and event lines
 * (which also have no parent_id).
 */
declare function topLevelComments(entries: Entry[]): Entry[];
/** Comment/reply ids tombstoned by a `deleted` event. */
declare function deletedCommentIds(entries: Entry[]): Set<string>;
/** Suggestion ids that have received a qualified resolve, in append order. */
declare function decidedSuggestions(entries: Entry[]): Map<string, SuggestionResolution>;
/**
 * The only suggestion in a thread that may be decided: the latest surviving
 * suggestion, provided it has not already received a qualified resolve.
 */
declare function actionableSuggestion(entries: Entry[], threadId: string): Entry | undefined;
interface ThreadSuggestionState {
    actionable: string | null;
    decided: Record<string, SuggestionResolution>;
}
/** Keep CLI commands and watch payloads on one suggestion-state shape. */
declare function threadSuggestionState(entries: Entry[], threadId: string): ThreadSuggestionState;
/**
 * comment_id -> latest edited body (last edit event wins). The JSONL keeps every
 * version; this resolves the effective body so an edited comment reads as its
 * newest text. Used wherever a comment is displayed — keep this the one place
 * edits are applied, so every consumer stays consistent.
 */
declare function latestBodyByComment(entries: Entry[]): Map<string, string>;
/**
 * Thread ids whose LATEST resolve/unresolve event is 'resolved'
 * (last-event-wins; unresolve can flip a thread back open).
 */
declare function resolvedThreadIds(entries: Entry[]): Set<string>;
/**
 * thread_id -> derived lifecycle status (pending|acknowledged|resolved).
 *
 * Walks lifecycle events (acknowledged/resolved/unresolved) in file order.
 * - `resolved`     -> resolved
 * - `unresolved`   -> drop back to acknowledged-if-ever-acked, else pending
 * - `acknowledged` -> acknowledged
 *
 * A thread with no lifecycle events is `pending`. Threads not seen here are
 * pending by absence.
 */
declare function threadStatusMap(entries: Entry[]): Map<string, Lifecycle>;
/** parent_id -> its non-deleted reply entries (unsorted). */
declare function survivingRepliesByParent(entries: Entry[], deleted: Set<string>): Map<string, Entry[]>;
/**
 * One record per surviving thread.
 *
 * Survival: a resolved thread is kept (flagged resolved); a top-level comment
 * deleted with no surviving replies drops entirely (the thread is gone).
 *
 * `user` is the configured "user" name — used to derive `awaiting` from the
 * latest turn. Surviving comments/replies and qualified suggestion decisions
 * are turns; lifecycle and edit/delete events are not. If the user acted last,
 * the ball is in the agent's court (awaiting: agent). Derived, not stored.
 */
declare function deriveThreads(entries: Entry[], user: string): Thread[];
/**
 * Surviving, non-resolved threads where the last entry is from `user` —
 * i.e. the ball is in the agent's court.
 */
declare function openThreadsAwaitingAgent(entries: Entry[], user: string): Thread[];

/**
 * The sidecar: read, append, and derive over a doc's `.comments.jsonl`.
 *
 * The rules here are authoritative; clients import them rather than
 * reproducing them.
 *
 * Model (append-only, derive-on-read):
 *   - A *comment* or *reply* line has no `type` field. Top-level comments carry
 *     an `anchor`; replies carry a `parent_id`.
 *   - An *event* line carries a `type`:
 *       resolved / unresolved  — act on a thread (thread_id)
 *       acknowledged           — act on a thread (thread_id)
 *       edit / deleted         — act on one comment/reply (comment_id)
 *   - "Latest event wins": a thread's status / a comment's body is whatever the
 *     last relevant event says.
 *
 * Status lifecycle (derived, per thread):
 *   pending      -> no acknowledged/resolved events
 *   acknowledged -> latest lifecycle event is `acknowledged`
 *   resolved     -> latest resolve event is `resolved`
 *   (unresolve flips a thread back; its lifecycle status falls to
 *    acknowledged if it was ever acknowledged, else pending.)
 */

declare const SIDECAR_SUFFIX = ".comments.jsonl";
/** A batch entry failed validation. Carries a human-readable message. */
declare class ValidationError extends Error {
    constructor(message: string);
}
/**
 * The sidecar path for a `.md` file: `<name>.md` -> `<name>.md.comments.jsonl`.
 *
 * Appends the suffix to the full name (NOT a suffix replacement, which would
 * lose the `.md` — and `.md` names can themselves contain dots, e.g.
 * `PROJECT.md`).
 */
declare function sidecarPathFor(mdPath: string): string;
/** Inverse of sidecarPathFor: strip the literal suffix to get the `.md`. */
declare function mdPathFor(sidecarPath: string): string;
/** All entries in file order. Missing file -> []. Blank lines skipped. */
declare function readSidecar(sidecarPath: string): Entry[];
/** Atomically append entries: one write so all land or none do. */
declare function appendEntries(sidecarPath: string, entries: Entry[]): void;
/** Convenience single-entry append. */
declare function appendEntry(sidecarPath: string, entry: Entry): void;
/** Count of threads awaiting the agent — for file-tree badges. */
declare function countOpenThreads(sidecarPath: string, user: string): number;
/**
 * Remove the sidecar if it has zero surviving threads (all tombstoned).
 * Resolved-only files are KEPT (resolved != gone). Returns true if removed.
 *
 * `user` is threaded through only because deriveThreads requires it; survival
 * doesn't depend on the user name.
 */
declare function pruneIfEmpty(sidecarPath: string, user: string): boolean;
/** ISO-8601 timestamp for a new entry. */
declare function nowIso(): string;
/** A fresh 12-hex-char entry id. */
declare function newId(): string;
/**
 * Validate a batch and return prepared entries (with id/file/author/timestamp
 * filled), ready to append. Throws ValidationError on the first bad entry.
 *
 * `existing` is the current sidecar contents (for id/thread lookups);
 * `fileName` is the .md's name (recorded on each entry); `author` is the
 * writer.
 */
declare function buildEntries(batch: unknown, existing: Entry[], fileName: string, author: string): Entry[];

/**
 * Who is "the user"? — config-driven.
 *
 * The sidecar records each entry's `author` as a free-form name (the writing
 * agent or the human). The server/CLI need to know which author is *the user*
 * so they can derive whose turn it is and style the UI by role.
 *
 * Resolution order (first hit wins):
 *   1. MDC_USER env var
 *   2. `user` key in `~/.mdc.toml` (identity follows the user, not the content tree)
 *   3. `user` key in `<root>/.mdc.toml` (per-tree override, when a root is passed)
 *   4. default "user"
 *
 * Home-dir config is checked before the root because "who am I" is a property
 * of the person, not of whatever folder the server happens to be launched on.
 * The per-root file is a deliberate override for that one tree.
 *
 * The default is intentional: an unconfigured clone still works, it just calls
 * the human "user" instead of guessing a name.
 */
declare const DEFAULT_USER = "user";
declare const CONFIG_FILENAME = ".mdc.toml";
type IdentitySource = "env" | "home" | "root" | "default";
/** Injectable environment for tests; defaults to the real process/OS. */
interface IdentityEnv {
    env?: Record<string, string | undefined>;
    home?: string;
}
/**
 * The configured name for "the user". See module doc for resolution order.
 *
 * `root` is an optional per-tree override location (the server's launch root).
 * Home-dir config (`~/.mdc.toml`) is always checked, so a caller with no root
 * still resolves the user's identity.
 */
declare function currentUser(root?: string | null, deps?: IdentityEnv): string;
/** The configured user name plus the source that supplied it. */
declare function currentUserWithSource(root?: string | null, deps?: IdentityEnv): {
    name: string;
    source: IdentitySource;
};
/** The home identity config path for commands that write user-level settings. */
declare function homeConfigPath(deps?: IdentityEnv): string;

/**
 * Edit-aware anchor resolution — where a stored anchor lives in the current
 * text, if anywhere.
 *
 * Priority:
 *   (0) anchor.context present → match quote+context as a unique fingerprint.
 *       Unique hit → live there. Zero or multiple → orphan. No line tiebreak,
 *       no nearest-twin fallback: the fingerprint either pins the right
 *       occurrence or the comment orphans. This is the drift-proof path.
 *   (1) unique exact quote match → use it.
 *   (2) legacy multi-occurrence (no context) → nearest anchor.line, but ONLY
 *       within LEGACY_DRIFT_CEILING lines; beyond that → orphan (so even old
 *       comments fail safe instead of jumping to a far twin).
 *   (3) no exact match → bounded fuzzy recovery (whitespace-normalized, then
 *       markdown-stripped) if it yields a UNIQUE near-match; else null.
 *
 * Conservative by design — prefer a false orphan over a false match, since a
 * mis-anchored comment is worse than a missing one.
 *
 * The text being matched against is the caller's choice: the CLI resolves
 * against the raw markdown (exact line counting); a rendered view can inject
 * its own offset→line mapper via `lineOf`.
 */

/**
 * Max line distance a legacy (no-context) multi-occurrence match may sit from
 * its stored anchor.line before we treat it as drift and orphan instead. Only
 * applies to old comments saved without a context fingerprint; new comments
 * disambiguate by context and never reach this branch.
 */
declare const LEGACY_DRIFT_CEILING = 25;
interface AnchorMatch {
    startIdx: number;
    length: number;
    /** True when the match needed fuzzy/normalized recovery (text changed). */
    recovered: boolean;
}
interface MatchOptions {
    /** Offset→1-indexed-line mapper; defaults to exact newline counting. */
    lineOf?: (text: string, offset: number) => number;
}
/** Every index where `needle` occurs in `hay`. */
declare function allIndexesOf(hay: string, needle: string): number[];
/**
 * Surrounding context for one occurrence of a quote. The window grows equally
 * on both sides until the resulting fingerprint is unique, capped at 40
 * characters per side. Callers that do not need a fingerprint for a unique
 * bare quote can skip this helper.
 */
declare function captureContext(full: string, at: number, quote: string): Required<AnchorContext> | undefined;
/** Exact 1-indexed line of a character offset in raw text. */
declare function lineOfOffset(text: string, offset: number): number;
/** Strip inline markdown (links, bold, italics, code) from a quote. */
declare function stripInlineMd(s: string): string;
/**
 * Strip markdown decoration (inline markers + line-leading block markers) from
 * a FULL text, returning the stripped string plus a map from stripped-offset →
 * original-offset — so a match found in the stripped view converts back to a
 * range in the original text. Runs passes to a fixpoint so nested markers
 * (bold wrapping code, etc.) unwrap fully.
 */
declare function stripMdMapped(s: string): {
    text: string;
    map: number[];
};
/**
 * Collapse runs of whitespace to single spaces, returning the transformed
 * string plus a map from transformed-offset → original-offset.
 */
declare function collapseWs(s: string): {
    text: string;
    map: number[];
};
/**
 * Bounded fuzzy match: whitespace-normalize both sides, require a UNIQUE hit,
 * then map the normalized hit back to original full-text offsets. Also tries a
 * markdown-stripped variant of the quote. Returns a match against the ORIGINAL
 * fullText (so range offsets stay valid) or null.
 */
declare function fuzzyFind(fullText: string, quote: string): AnchorMatch | null;
/**
 * Locate a write target only when its raw quote plus stored context fingerprint
 * occurs exactly once. Unlike display-anchor matching, this never normalizes
 * whitespace, strips markdown, or falls back to a nearby occurrence.
 */
declare function findTargetStrict(anchor: Anchor, fullText: string): AnchorMatch | null;
/**
 * Edit-aware anchor matching. Returns { startIdx, length, recovered } or null
 * (the anchor is orphaned in this text).
 *
 * Quotes are captured from RENDERED text, so when the text being searched is
 * raw markdown, inline markers (**bold**, `code`, links) inside the quoted
 * span defeat every direct stage. If direct matching fails, retry against a
 * marker-stripped view of the text and map the hit back to original offsets —
 * same uniqueness discipline, so it stays prefer-orphan-over-mis-anchor.
 */
declare function findAnchorMatch(anchor: Anchor, fullText: string, opts?: MatchOptions): AnchorMatch | null;

type ApplySuggestionResult = {
    ok: true;
    content: string;
} | {
    ok: false;
    reason: "target-not-found";
};
/** Apply a suggestion only when its raw target fingerprint still matches once. */
declare function applySuggestion(rawText: string, suggestion: Suggestion): ApplySuggestionResult;

/**
 * Handoff client for the mdc watch loop — the agent-side of the turn-taking.
 *
 * The server hosts /api/handoff/{open,events,done}. This module opens a session
 * and blocks on the SSE event stream until the user signals, parsing the stream
 * by hand — global fetch speaks streaming responses, no extra deps. The general
 * "is the server up / what's pending" queries live in server-client.ts.
 */
declare class HandoffError extends Error {
    constructor(message: string);
}
interface HandoffSession {
    sessionId: string;
    file: string;
    baseUrl: string;
}
/**
 * Open a new handoff session for `file`. Throws HandoffError if the server
 * rejects (e.g., another session is already live).
 */
declare function openSession(file: string, baseUrl?: string): Promise<HandoffSession>;
/**
 * Block until the server fires `done`. Returns the intent string.
 *
 * Reconnects on transient stream drops up to `reconnectMax` times. Only
 * returns when a real `done` event arrives; heartbeats are ignored. A stream
 * the server closes cleanly without a done event is fatal, not retried.
 */
declare function waitForDone(session: HandoffSession, reconnectMax?: number, timeoutMs?: number): Promise<string>;
declare function normalizeIntent(intent: string | null): string | null;
/**
 * Open a handoff session for `fileRel` and block until the server fires
 * `done`, returning the normalized intent — or null on handoff failure.
 */
declare function waitForSignal(fileRel: string, baseUrl: string, timeoutMs?: number): Promise<string | null>;

type handoff_HandoffError = HandoffError;
declare const handoff_HandoffError: typeof HandoffError;
type handoff_HandoffSession = HandoffSession;
declare const handoff_normalizeIntent: typeof normalizeIntent;
declare const handoff_openSession: typeof openSession;
declare const handoff_waitForDone: typeof waitForDone;
declare const handoff_waitForSignal: typeof waitForSignal;
declare namespace handoff {
  export { handoff_HandoffError as HandoffError, type handoff_HandoffSession as HandoffSession, handoff_normalizeIntent as normalizeIntent, handoff_openSession as openSession, handoff_waitForDone as waitForDone, handoff_waitForSignal as waitForSignal };
}

/**
 * Thin HTTP client for the running server — the queries the CLI makes against
 * it that aren't part of the handoff turn-taking: is it up, what's its root,
 * what's pending for a file. Best-effort: every call swallows network errors
 * and returns a null/false/empty answer rather than throwing, because "the
 * server isn't reachable" is a normal state the caller handles, not an error.
 */

declare const DEFAULT_BASE_URL: string;
/**
 * The active handoff session info ({file, sessionId, ...}) or null. Useful for
 * callers that want to check "is anything listening" before opening.
 */
declare function activeSession(baseUrl?: string): Promise<Record<string, unknown> | null>;
/** Quick check that the server is running. */
declare function serverAlive(baseUrl?: string): Promise<boolean>;
/**
 * Whether a browser tab is currently connected to the server (an open live SSE
 * stream). Lets the CLI skip spawning a redundant tab when one is already live.
 * Best-effort: false if the server is unreachable or doesn't answer.
 */
declare function serverTabConnected(baseUrl?: string): Promise<boolean>;
/** The server's /api/index payload ({root, files}), or null if unreachable. */
declare function serverIndex(baseUrl?: string): Promise<Record<string, unknown> | null>;
/**
 * What a probe finds at a base URL:
 * - `free`     — nothing answered (the port is open for us to bind).
 * - `foreign`  — something answered, but it isn't an mdc server (its /api/index
 *                payload doesn't have the {root, files} shape). A real conflict.
 * - otherwise  — an mdc server is running; `root` is the absolute root it serves.
 */
type ProbeResult = {
    kind: "free";
} | {
    kind: "foreign";
} | {
    kind: "mdc";
    root: string;
};
/**
 * Identify what (if anything) is serving at `baseUrl`. Distinguishes an mdc server
 * from an unrelated server on the same port by checking the /api/index shape,
 * so a caller about to bind the port can adopt an existing server, refuse a
 * foreign occupant, or proceed when the port is free.
 */
declare function probeServer(baseUrl?: string): Promise<ProbeResult>;
/**
 * Pending-agent threads and their suggestion state for a root-relative file.
 * Resolves the absolute path via the served root, then reads the sidecar
 * through the core.
 */
declare function pendingFor(fileRel: string, baseUrl: string): Promise<Array<Thread & {
    suggestion_state: ThreadSuggestionState;
}>>;

declare const serverClient_DEFAULT_BASE_URL: typeof DEFAULT_BASE_URL;
type serverClient_ProbeResult = ProbeResult;
declare const serverClient_activeSession: typeof activeSession;
declare const serverClient_pendingFor: typeof pendingFor;
declare const serverClient_probeServer: typeof probeServer;
declare const serverClient_serverAlive: typeof serverAlive;
declare const serverClient_serverIndex: typeof serverIndex;
declare const serverClient_serverTabConnected: typeof serverTabConnected;
declare namespace serverClient {
  export { serverClient_DEFAULT_BASE_URL as DEFAULT_BASE_URL, type serverClient_ProbeResult as ProbeResult, serverClient_activeSession as activeSession, serverClient_pendingFor as pendingFor, serverClient_probeServer as probeServer, serverClient_serverAlive as serverAlive, serverClient_serverIndex as serverIndex, serverClient_serverTabConnected as serverTabConnected };
}

declare const VERSION: string;

export { type Anchor, type AnchorContext, type AnchorMatch, type ApplySuggestionResult, type Awaiting, CONFIG_FILENAME, DEFAULT_USER, EVENT_TYPES, type Entry, type IdentityEnv, type IdentitySource, LEGACY_DRIFT_CEILING, LIFECYCLE_TYPES, type Lifecycle, type MatchOptions, RESOLVE_TYPES, SIDECAR_SUFFIX, type Suggestion, type SuggestionResolution, type Thread, type ThreadStatus, type ThreadSuggestionState, VERSION, ValidationError, actionableSuggestion, allIndexesOf, appendEntries, appendEntry, applySuggestion, buildEntries, captureContext, collapseWs, countOpenThreads, currentUser, currentUserWithSource, decidedSuggestions, deletedCommentIds, deriveThreads, findAnchorMatch, findTargetStrict, fuzzyFind, handoff, homeConfigPath, isEvent, latestBodyByComment, lineOfOffset, mdPathFor, newId, nowIso, openThreadsAwaitingAgent, pruneIfEmpty, readSidecar, resolvedThreadIds, serverClient, sidecarPathFor, stripInlineMd, stripMdMapped, survivingRepliesByParent, threadStatusMap, threadSuggestionState, topLevelComments };
