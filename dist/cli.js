#!/usr/bin/env node
import {
  CONFIG_FILENAME,
  VERSION,
  ValidationError,
  allIndexesOf,
  appendEntries,
  buildEntries,
  captureContext,
  currentUser,
  currentUserWithSource,
  deletedCommentIds,
  findAnchorMatch,
  homeConfigPath,
  latestBodyByComment,
  lineOfOffset,
  openThreadsAwaitingAgent,
  pendingFor,
  probeServer,
  readSidecar,
  serverAlive,
  serverIndex,
  serverTabConnected,
  sidecarPathFor,
  stripMdMapped,
  survivingRepliesByParent,
  threadSuggestionState,
  topLevelComments,
  waitForSignal
} from "./chunk-5DLARLQ5.js";

// src/cli.ts
import { spawn as spawn2, execFile } from "child_process";
import { promisify } from "util";
import { cpSync, existsSync, readdirSync, readFileSync as readFileSync2, realpathSync, writeFileSync } from "fs";
import { basename, dirname, join as join2, relative, resolve as resolvePath, isAbsolute } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Command, CommanderError } from "commander";
import { parse as parseToml2, stringify as stringifyToml } from "smol-toml";

// src/launch.ts
import { spawn, spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseToml } from "smol-toml";
function readAppWindowConfig(root) {
  let text;
  try {
    text = readFileSync(join(root, CONFIG_FILENAME), "utf8");
  } catch {
    return false;
  }
  try {
    return parseToml(text).app_window === true;
  } catch {
    return false;
  }
}
async function openInBrowser(url, env = {}) {
  const spawnFn = env.spawnFn ?? spawn;
  const opener = (env.platform ?? process.platform) === "darwin" ? ["open", url] : (env.platform ?? process.platform) === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  await new Promise((res, rej) => {
    const p = spawnFn(opener[0], opener.slice(1), { stdio: "ignore" });
    p.on("error", rej);
    p.on("exit", (code) => code === 0 ? res() : rej(new Error(`exit ${code}`)));
  });
}
async function openWorkspaceWindow(url, appWindow, env = {}) {
  const noBrowser = env.noBrowser ?? process.env.MDC_NO_BROWSER === "1";
  if (noBrowser) {
    console.log(`mdc: not launching a browser (MDC_NO_BROWSER=1) \u2014 open ${url}`);
    return;
  }
  const platform = env.platform ?? process.platform;
  const spawnSyncFn = env.spawnSyncFn ?? spawnSync;
  if (appWindow && platform === "darwin") {
    const chromeInstalled = spawnSyncFn("open", ["-Ra", "Google Chrome"], { stdio: "ignore" }).status === 0;
    if (chromeInstalled) {
      const spawnFn = env.spawnFn ?? spawn;
      const ok = await new Promise((res) => {
        const p = spawnFn("open", ["-na", "Google Chrome", "--args", `--app=${url}`], {
          stdio: "ignore"
        });
        p.on("error", () => res(false));
        p.on("exit", (code) => res(code === 0));
      });
      if (ok) return;
    }
  }
  await openInBrowser(url, env);
}

// src/cli.ts
var DEFAULT_BASE_URL = "http://localhost:8000";
var DEFAULT_PORT = 8e3;
var CliError = class extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
    this.name = "CliError";
  }
  exitCode;
};
function resolveFile(fileArg) {
  const mdPath = resolvePath(fileArg);
  const scPath = sidecarPathFor(mdPath);
  return { mdPath, scPath, entries: readSidecar(scPath) };
}
function write(scPath, batch, existing, fileName, author) {
  let prepared;
  try {
    prepared = buildEntries(batch, existing, fileName, author);
  } catch (e) {
    if (e instanceof ValidationError) throw new CliError(e.message);
    throw e;
  }
  appendEntries(scPath, prepared);
  return prepared;
}
function threadArc(entries, threadId) {
  const deleted = deletedCommentIds(entries);
  const edited = latestBodyByComment(entries);
  const tops = new Map(topLevelComments(entries).map((t) => [t.id, t]));
  const top = tops.get(threadId);
  if (!top) return null;
  const byParent = survivingRepliesByParent(entries, deleted);
  const replies = [...byParent.get(threadId) ?? []].sort(
    (a, b) => (a.timestamp ?? "") < (b.timestamp ?? "") ? -1 : (a.timestamp ?? "") > (b.timestamp ?? "") ? 1 : 0
  );
  if (deleted.has(threadId) && replies.length === 0) {
    return null;
  }
  const bodyOf = (e) => deleted.has(e.id) ? "[deleted]" : edited.get(e.id) ?? e.body ?? "";
  const anchor = top.anchor ?? {};
  return {
    thread_id: threadId,
    quote: anchor.quote ?? "",
    line: anchor.line ?? null,
    suggestion_state: threadSuggestionState(entries, threadId),
    entries: [top, ...replies].map((e) => ({
      id: e.id,
      author: e.author ?? null,
      body: bodyOf(e),
      timestamp: e.timestamp ?? null,
      ...e.suggestion === void 0 ? {} : { suggestion: e.suggestion }
    }))
  };
}
function userFor(mdPath) {
  return currentUser(dirname(mdPath));
}
function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
function resolveServeRoot(root) {
  return root ?? process.cwd();
}
function cmdListPending(file) {
  const { mdPath, entries } = resolveFile(file);
  const awaiting = openThreadsAwaitingAgent(entries, userFor(mdPath)).map((thread) => ({
    ...thread,
    suggestion_state: threadSuggestionState(entries, thread.thread_id)
  }));
  printJson({ file: mdPath, pending: awaiting });
  return 0;
}
function cmdGetThread(file, threadId) {
  const { entries } = resolveFile(file);
  const arc = threadArc(entries, threadId);
  if (arc === null) {
    console.error(`error: thread '${threadId}' not found or not surviving`);
    return 1;
  }
  printJson(arc);
  return 0;
}
function buildSuggestion(mdPath, replacement, target) {
  if (replacement === void 0) {
    if (target !== void 0) throw new CliError("--target requires --suggest");
    return void 0;
  }
  if (target === void 0) throw new CliError("--target is required with --suggest");
  let full;
  try {
    full = readFileSync2(mdPath, "utf8");
  } catch {
    throw new CliError(`could not read suggestion target from '${mdPath}'`);
  }
  const occurrences = allIndexesOf(full, target);
  if (occurrences.length !== 1) {
    throw new CliError(
      "suggestion target must occur exactly once in the document; pass a longer target"
    );
  }
  const captured = captureContext(full, occurrences[0], target);
  return {
    target: {
      quote: target,
      context: {
        before: captured?.before ?? "",
        after: captured?.after ?? ""
      }
    },
    replacement
  };
}
function cmdComment(file, opts) {
  const { mdPath, scPath, entries } = resolveFile(file);
  const anchor = { quote: opts.quote };
  if (opts.line !== void 0) anchor.line = opts.line;
  if (opts.contextBefore !== void 0 || opts.contextAfter !== void 0) {
    anchor.context = { before: opts.contextBefore ?? "", after: opts.contextAfter ?? "" };
  }
  if (opts.suggest !== void 0 && opts.target === void 0 && stripMdMapped(opts.quote).text !== opts.quote) {
    console.warn(
      "warning: --quote contains Markdown syntax; use rendered text for --quote and exact raw Markdown for --target, or the margin anchor may orphan"
    );
  }
  const suggestion = buildSuggestion(
    mdPath,
    opts.suggest,
    opts.target ?? (opts.suggest === void 0 ? void 0 : opts.quote)
  );
  const prepared = write(
    scPath,
    [{ anchor, body: opts.body, ...suggestion === void 0 ? {} : { suggestion } }],
    entries,
    basename(mdPath),
    opts.author
  );
  console.log(`commented: ${prepared[0].id}`);
  return 0;
}
function cmdReply(file, parentId, opts) {
  const { mdPath, scPath, entries } = resolveFile(file);
  const suggestion = buildSuggestion(mdPath, opts.suggest, opts.target);
  const prepared = write(
    scPath,
    [{ parent_id: parentId, body: opts.body, ...suggestion === void 0 ? {} : { suggestion } }],
    entries,
    basename(mdPath),
    opts.author
  );
  console.log(`replied: ${prepared[0].id}`);
  return 0;
}
function cmdThreadEvent(file, threadId, etype, author) {
  const { mdPath, scPath, entries } = resolveFile(file);
  const prepared = write(
    scPath,
    [{ type: etype, thread_id: threadId }],
    entries,
    basename(mdPath),
    author
  );
  console.log(`${etype}: thread ${threadId} (${prepared[0].id})`);
  return 0;
}
function cmdEdit(file, commentId, body, author) {
  const { mdPath, scPath, entries } = resolveFile(file);
  const prepared = write(
    scPath,
    [{ type: "edit", comment_id: commentId, body }],
    entries,
    basename(mdPath),
    author
  );
  console.log(`edited: ${commentId} (${prepared[0].id})`);
  return 0;
}
function cmdDelete(file, commentId, author) {
  const { mdPath, scPath, entries } = resolveFile(file);
  const prepared = write(
    scPath,
    [{ type: "deleted", comment_id: commentId }],
    entries,
    basename(mdPath),
    author
  );
  console.log(`deleted: ${commentId} (${prepared[0].id})`);
  return 0;
}
function cmdLocate(file, threadId) {
  const { mdPath, entries } = resolveFile(file);
  const tops = new Map(topLevelComments(entries).map((t) => [t.id, t]));
  const top = tops.get(threadId);
  if (!top) {
    console.error(`error: thread '${threadId}' not found`);
    return 1;
  }
  let text;
  try {
    text = readFileSync2(mdPath, "utf8");
  } catch {
    console.error(`error: cannot read ${mdPath}`);
    return 1;
  }
  const anchor = top.anchor ?? { quote: "" };
  const match = findAnchorMatch(anchor, text);
  const result = {
    thread_id: threadId,
    quote: anchor.quote ?? "",
    found: match !== null
  };
  if (match) {
    result.start = match.startIdx;
    result.length = match.length;
    result.line = lineOfOffset(text, match.startIdx);
    result.recovered = match.recovered;
  }
  printJson(result);
  return 0;
}
function readWritableHomeConfig(path) {
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch {
    return {};
  }
  try {
    return parseToml2(text);
  } catch {
    throw new CliError(`could not parse ${path}`);
  }
}
function cmdIdentity(nameArg, deps = {}) {
  if (nameArg === void 0) {
    const identity = currentUserWithSource(process.cwd(), deps);
    console.log(`identity: ${identity.name} (source: ${identity.source})`);
    return 0;
  }
  const name = nameArg.trim();
  if (!name) throw new CliError("identity name must not be empty");
  const path = homeConfigPath(deps);
  const config = readWritableHomeConfig(path);
  config.user = name;
  writeFileSync(path, stringifyToml(config), "utf8");
  console.log(`identity: ${name} (saved to ${path})`);
  return 0;
}
async function cmdCheck(baseUrl) {
  const alive = await serverAlive(baseUrl);
  console.log(alive ? "alive" : "down");
  return alive ? 0 : 1;
}
async function relForServer(file, baseUrl) {
  const index = await serverIndex(baseUrl);
  if (index === null) {
    console.error("down");
    return { error: "down" };
  }
  const root = resolvePath(String(index.root ?? ""));
  const target = resolvePath(file);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    console.error(`unreachable: ${target} is outside the served root ${root}`);
    return { error: "unreachable" };
  }
  return { rel, root };
}
async function cmdWatch(file, baseUrl, timeoutSec) {
  if (!await serverAlive(baseUrl)) {
    printJson({
      intent: "server-down",
      file,
      pending: [],
      note: "mdc server not reachable \u2014 review the sidecar directly (mdc list-pending / get-thread work without the server)"
    });
    return 0;
  }
  const resolved = await relForServer(file, baseUrl);
  if ("error" in resolved) {
    if (resolved.error === "down") {
      printJson({
        intent: "server-down",
        file,
        pending: [],
        note: "mdc server not reachable \u2014 review the sidecar directly"
      });
      return 0;
    }
    printJson({
      intent: "unreachable",
      file,
      pending: [],
      note: "file is outside the served root \u2014 serve a root that covers it"
    });
    return 0;
  }
  const rel = resolved.rel;
  const intent = await waitForSignal(rel, baseUrl, timeoutSec ? timeoutSec * 1e3 : void 0);
  if (intent === null) {
    printJson({ intent: "error", file, pending: [], note: "handoff wait failed" });
    return 1;
  }
  if (intent === "timeout") {
    printJson({
      intent: "timeout",
      file,
      pending: [],
      note: `no signal within ${timeoutSec}s \u2014 re-run watch to keep waiting`
    });
    return 0;
  }
  const pending = await pendingFor(rel, baseUrl);
  printJson({ intent, file, pending });
  return 0;
}
async function cmdOpen(file, baseUrl) {
  const resolved = await relForServer(file, baseUrl);
  if ("error" in resolved) return resolved.error === "down" ? 1 : 2;
  try {
    const r = await fetch(`${baseUrl}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: resolved.rel }),
      signal: AbortSignal.timeout(2e3)
    });
    if (r.ok) {
      console.log(`opened: ${resolved.rel}`);
      return 0;
    }
  } catch {
  }
  const url = `${baseUrl}/?file=${encodeURIComponent(resolved.rel)}`;
  try {
    await openWorkspaceWindow(url, readAppWindowConfig(resolved.root));
  } catch (e) {
    console.error(`error: could not open browser: ${String(e)}`);
    return 1;
  }
  console.log(`opened: ${resolved.rel}`);
  return 0;
}
var execFileAsync = promisify(execFile);
async function stopServerOnPort(port, baseUrl) {
  let pids = [];
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`]);
    pids = stdout.split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    pids = [];
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
  }
  const deadline = Date.now() + 5e3;
  while (Date.now() < deadline) {
    if ((await probeServer(baseUrl)).kind === "free") return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return (await probeServer(baseUrl)).kind === "free";
}
async function cmdStop(port) {
  const baseUrl = `http://localhost:${port}`;
  const probe = await probeServer(baseUrl);
  if (probe.kind === "free") {
    console.log(`nothing to stop on port ${port}`);
    return 0;
  }
  if (probe.kind === "foreign") {
    console.error(
      `error: port ${port} is held by something that isn't an mdc server \u2014 refusing to stop it`
    );
    return 1;
  }
  if (await stopServerOnPort(port, baseUrl)) {
    console.log(`stopped the mdc server on port ${port}`);
    return 0;
  }
  console.error(`error: could not free port ${port} \u2014 the mdc server is still running`);
  return 1;
}
async function cmdServe(root, opts) {
  const baseUrl = `http://localhost:${opts.port}`;
  const wantRoot = resolvePath(root);
  const appWindow = opts.appWindow || readAppWindowConfig(wantRoot);
  let switched = false;
  const probe = await probeServer(baseUrl);
  if (probe.kind === "foreign") {
    console.error(
      `error: port ${opts.port} is in use by something that isn't an mdc server \u2014 stop it or choose another --port`
    );
    return 1;
  }
  if (probe.kind === "mdc") {
    const sameRoot = resolvePath(probe.root) === wantRoot;
    if (opts.restart) {
      console.log(`restarting the mdc server on ${baseUrl}`);
      if (!await stopServerOnPort(opts.port, baseUrl)) {
        console.error(
          `error: could not free port ${opts.port} \u2014 the existing mdc server is still running`
        );
        return 1;
      }
      switched = true;
    } else if (sameRoot) {
      console.log(`already running: ${probe.root} on ${baseUrl}`);
      if (opts.open && !await serverTabConnected(baseUrl)) {
        await openWorkspaceWindow(baseUrl, appWindow).catch(() => {
        });
      }
      return 0;
    } else if (!opts.force) {
      console.error(
        `error: an mdc server is already running on ${baseUrl}, serving ${probe.root} \u2014 not ${wantRoot}. Re-run with --force to stop it and serve ${wantRoot} instead.`
      );
      return 1;
    } else {
      console.log(`stopping the mdc server on ${probe.root} to switch to ${wantRoot}`);
      if (!await stopServerOnPort(opts.port, baseUrl)) {
        console.error(
          `error: could not free port ${opts.port} \u2014 the existing mdc server is still running`
        );
        return 1;
      }
      switched = true;
    }
  }
  if (opts.foreground) {
    const { startServer } = await import("./serve-QRJFO5TJ.js");
    await startServer(root, {
      port: opts.port,
      deny: opts.deny,
      staticDir: opts.staticDir
    });
    if (opts.open && !switched) await openWorkspaceWindow(baseUrl, appWindow).catch(() => {
    });
    await new Promise(() => {
    });
    return 0;
  }
  const cliPath = process.argv[1];
  if (!cliPath) {
    console.error("error: cannot locate the mdc executable to background it");
    return 1;
  }
  const childArgs = [cliPath, "serve", root, "--port", String(opts.port), "--foreground", "--no-open"];
  if (opts.deny) childArgs.push("--deny", opts.deny);
  if (opts.staticDir) childArgs.push("--static-dir", opts.staticDir);
  const child = spawn2(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  const deadline = Date.now() + 1e4;
  let up = false;
  while (Date.now() < deadline) {
    if ((await probeServer(baseUrl)).kind === "mdc") {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    console.error(`error: mdc server did not come up on ${baseUrl} within 10s`);
    return 1;
  }
  console.log(`serving ${wantRoot} on ${baseUrl} (pid ${child.pid})`);
  if (currentUserWithSource(wantRoot).source === "default") {
    console.log('tip: comments are attributed as "user" \u2014 set your name: mdc identity <name>');
  }
  if (opts.open && !switched) await openWorkspaceWindow(baseUrl, appWindow).catch(() => {
  });
  return 0;
}
function buildProgram(setExit) {
  const program = new Command();
  program.name("mdc").description(
    "mdc \u2014 a local markdown workspace for you and your coding agent. Serves a folder in the browser: renders markdown, images, PDFs, and HTML; review docs together in the margin (threads \u2014 including suggested edits the human accepts or rejects \u2014 stored next to each file in a .comments.jsonl sidecar); edit in place; and run trusted HTML files as mini apps over your workspace."
  ).version(VERSION).option("--author <name>", "who is writing these entries", "agent").addHelpText(
    "after",
    `
typical review loop:
  mdc check                          # is the mdc server running?
  mdc watch  /abs/doc.md             # block until the user hands off
  mdc list-pending /abs/doc.md       # threads awaiting you (JSON)
  mdc reply  /abs/doc.md <tid> --body "..."
             [--suggest "new text" --target "exact raw text"]   # propose an edit
  mdc watch  /abs/doc.md             # re-arm for the next round
                                     # (resolving and accepting/rejecting
                                     #  suggestions are the human's actions)

new to mdc? \`mdc setup\` prints the agent setup doc \u2014 the full loop and
how to wire an agent in. \`file\` is an absolute path for every file command
(watch, list-pending, get-thread, comment, reply, *resolve). thread/parent
ids come from list-pending's output. Run \`mdc <command> -h\` for detail.`
  );
  const author = (cmd) => cmd.optsWithGlobals().author;
  program.command("list-pending").summary("threads awaiting the agent (JSON)").description(
    "List the comment threads on a doc that are awaiting your reply \u2014 the user spoke last and the thread isn't resolved. Prints {file, pending: [thread summaries]} as JSON; each summary carries the thread_id you pass to reply/resolve, plus suggestion_state \u2014 the actionable suggestion id and past applied/dismissed decisions."
  ).argument("<file>", "absolute path to the .md").action(function(file) {
    setExit(cmdListPending(file));
  });
  program.command("get-thread").summary("one thread's full arc (JSON)").description(
    "Print one thread's full arc \u2014 parent comment plus surviving replies, with edits and deletes already folded in, plus suggestion_state (actionable/decided suggestions). Errors if the thread doesn't survive (parent deleted, no replies)."
  ).argument("<file>", "absolute path to the .md").argument("<thread_id>", "top-level comment id (from list-pending)").action(function(file, threadId) {
    setExit(cmdGetThread(file, threadId));
  });
  program.command("comment").summary("add a top-level comment").description(
    "Add a new top-level comment anchored to --quote (exact text copied from the doc). --line pins which occurrence when the quote repeats. With --suggest it also carries a proposed replacement for the --target span (exact raw markdown; defaults to --quote) that the user accepts or rejects on the card. Prints the new comment id."
  ).argument("<file>", "absolute path to the .md").requiredOption("--quote <text>", "exact text from the doc to anchor the comment to").requiredOption("--body <text>", "the comment text").option("--suggest <replacement>", "attach a suggested replacement (empty means delete)").option("--target <quote>", "raw markdown target (defaults to --quote with --suggest)").option(
    "--line <n>",
    "pin the occurrence when --quote appears more than once",
    (v) => parseInt(v, 10)
  ).option(
    "--context-before <text>",
    "text just before the quote (anti-drift fingerprint for repeated quotes; pair with --context-after)"
  ).option("--context-after <text>", "text just after the quote (see --context-before)").action(function(file, opts) {
    setExit(cmdComment(file, { ...opts, author: author(this) }));
  });
  program.command("reply").summary("reply to a thread").description(
    `Reply to an existing thread (parent_id = the top-level comment id from list-pending). With --suggest/--target the reply carries a proposed edit the user accepts or rejects on the card. Prints the new reply id.

If you have a QUESTION for the user about the doc, ask it here, in the margin \u2014 anchored, persistent review discussion is what reply is for; the user answers next turn. Use the terminal only for urgent / out-of-band signals that don't belong on a line ("this will delete X \u2014 confirm?", "the file won't parse"), not ordinary review questions.`
  ).argument("<file>", "absolute path to the .md").argument("<parent_id>", "top-level comment id being replied to").requiredOption("--body <text>", "the reply text").option("--suggest <replacement>", "attach a suggested replacement (empty means delete)").option("--target <quote>", "raw markdown target (required with --suggest)").action(function(file, parentId, opts) {
    setExit(cmdReply(file, parentId, { ...opts, author: author(this) }));
  });
  const statusBlurb = {
    acknowledge: "Mark a thread acknowledged ('seen, working on it') without replying yet \u2014 distinct from resolved. Prints the event id.",
    resolve: "Mark a thread resolved (done) so it drops out of the pending / list-pending view. Prints the event id.",
    unresolve: "Re-open a previously resolved thread so it shows as pending again. Prints the event id."
  };
  for (const [name, etype] of [
    ["acknowledge", "acknowledged"],
    ["resolve", "resolved"],
    ["unresolve", "unresolved"]
  ]) {
    program.command(name).summary(`mark a thread ${name}d`).description(statusBlurb[name]).argument("<file>", "absolute path to the .md").argument("<thread_id>", "top-level comment id (from list-pending)").action(function(file, threadId) {
      setExit(cmdThreadEvent(file, threadId, etype, author(this)));
    });
  }
  program.command("edit").summary("edit a comment or reply body").description(
    "Replace the displayed body of one comment OR reply (comment_id = any comment/reply id, not an event). Append-only and last-edit-wins \u2014 every version stays in the jsonl, the UI shows the newest. Prints the edit event id."
  ).argument("<file>", "absolute path to the .md").argument("<comment_id>", "id of the comment/reply to edit").requiredOption("--body <text>", "the replacement text (non-empty)").action(function(file, commentId, opts) {
    setExit(cmdEdit(file, commentId, opts.body, author(this)));
  });
  program.command("delete").summary("delete a comment or reply").description(
    "Tombstone one comment OR reply (comment_id = any comment/reply id). A deleted top-level shows [deleted] but keeps its replies and anchor; a deleted reply is hidden. Append-only and recoverable in the file. Prints the delete event id."
  ).argument("<file>", "absolute path to the .md").argument("<comment_id>", "id of the comment/reply to delete").action(function(file, commentId) {
    setExit(cmdDelete(file, commentId, author(this)));
  });
  program.command("locate").summary("where a thread's anchor lives in the doc now (JSON)").description(
    "Resolve a thread's anchor against the current text of the .md \u2014 context-fingerprint match first, then exact, then bounded fuzzy recovery. Prints {thread_id, quote, found, start, length, line, recovered} as JSON; found: false means the anchor is orphaned (its text was edited away). Conservative: ambiguity orphans, never guesses."
  ).argument("<file>", "absolute path to the .md").argument("<thread_id>", "top-level comment id (from list-pending)").action(function(file, threadId) {
    setExit(cmdLocate(file, threadId));
  });
  program.command("check").summary("server alive/down").description(
    "Probe whether the mdc server is running (exit 0 = alive, 1 = down). The live `watch` turn-taking needs it; if it's down, review the sidecar directly via list-pending / get-thread \u2014 those work with no server."
  ).option("--base-url <url>", "server base URL", DEFAULT_BASE_URL).action(async function(opts) {
    setExit(await cmdCheck(opts.baseUrl));
  });
  program.command("watch").summary("block until the user signals; return intent + pending").description(
    "Block until the user signals a turn (Hand off / End session in the browser), then print {intent, file, pending} as JSON. The turn-taking primitive: call it, act on the result, then call it again for the next round. Run it as a normal FOREGROUND command and read its output when it returns \u2014 never in the background, where its result wakes nobody. With --timeout it returns within N seconds, so it's just a quick poll.\n\nAlways prints {intent, file, pending} as JSON \u2014 switch on `intent`:\n  review       the user handed off \u2014 reply to `pending`, then watch again.\n  done         the user ended the session \u2014 stop the loop.\n  timeout      --timeout elapsed with no signal \u2014 re-run watch to keep waiting.\n  server-down  mdc server not reachable \u2014 review the sidecar directly, don't retry.\n  unreachable  the file is outside the served root \u2014 nothing to watch."
  ).argument("<file>", "absolute path to the .md").option("--base-url <url>", "server base URL", DEFAULT_BASE_URL).option(
    "--timeout <seconds>",
    "stop waiting after N seconds and print {intent: 'timeout'} \u2014 for environments that cap command duration; re-run watch to keep waiting",
    (v) => parseInt(v, 10)
  ).action(async function(file, opts) {
    setExit(await cmdWatch(file, opts.baseUrl, opts.timeout));
  });
  program.command("open").summary("open a workspace file in the browser").description(
    "Open a markdown, image, PDF, HTML, or Excalidraw file in the browser tab of the running mdc server (does not start it; use `mdc serve` first). Exits non-zero with `down` if no server is running, or `unreachable` if the file is outside the served root, so the caller decides what to do.\n\nTakes one file and focuses it. To open several, run it once per file \u2014 each call adds the file as a tab and focuses it, so the last one opened is active and the earlier ones stay open in the tab strip."
  ).argument("<file>", "absolute path to an openable workspace file").option("--base-url <url>", "server base URL", DEFAULT_BASE_URL).action(async function(file, opts) {
    setExit(await cmdOpen(file, opts.baseUrl));
  });
  program.command("serve").summary("serve a root directory in the browser").description(
    "Serve the browser UI + comment API on a root directory: renders any .md under it, with margin comments, live-reload, and the handoff loop, then opens it in the browser. Runs in the background by default \u2014 the command returns once the server is up and the server keeps running, so the caller isn't blocked. Use --foreground to run it in this process and block until interrupted (e.g. to watch logs).\n\nThis is the single way to get the server up \u2014 no need to `check` first. If an mdc server already serves THIS root, it just opens the browser to it. If one is running on a DIFFERENT root it exits non-zero without opening anything (opening the wrong root would mislead); re-run with --force to stop that server and serve this root instead."
  ).argument("[root]", "directory to serve .md files from (default: current directory)").option("--port <n>", "port to serve on", (v) => parseInt(v, 10), DEFAULT_PORT).option("--deny <dirs>", "comma-separated extra dirs to exclude (adds to the built-in deny list)", "").option("--static-dir <dir>", "override the bundled static/ frontend dir").option("--no-open", "don't open the browser after the server is up").option("--force", "if an mdc server is running on a different root, stop it and serve this root", false).option("--restart", "stop any mdc server on the port (even same-root) and start fresh \u2014 picks up a rebuilt frontend/backend", false).option("--foreground", "run the server in this process and block (default: background)", false).option(
    "--app-window",
    "open a chromeless Chrome app window instead of a browser tab (macOS with Chrome installed; falls back to the browser). Set durably with app_window = true in <root>/.mdc.toml",
    false
  ).action(async function(root, opts) {
    setExit(await cmdServe(resolveServeRoot(root), opts));
  });
  program.command("stop").summary("stop the mdc server running on a port").description(
    "Stop the mdc server listening on a port. Only stops an actual mdc server \u2014 if something foreign holds the port it refuses (won't kill a stranger's process), and if nothing is listening it's a no-op success. Safe to run blindly."
  ).option("--port <n>", "port to stop", (v) => parseInt(v, 10), DEFAULT_PORT).action(async function(opts) {
    setExit(await cmdStop(opts.port));
  });
  program.command("identity").summary("show or set the user identity").description(
    "Show the configured human user name and where it came from, or set it in ~/.mdc.toml. This identity is used for turn-taking and UI role styling."
  ).argument("[name]", "name to save in ~/.mdc.toml").action(function(name) {
    setExit(cmdIdentity(name));
  });
  program.command("setup").summary("print the agent setup doc").description(
    "Print the agent setup doc (docs/agent-setup.md): what mdc is, the review loop, the comment commands, and how to persist the instructions in an agent's own harness. Meant to be read by a coding agent \u2014 tell yours to run `mdc setup` and follow it."
  ).action(function() {
    console.log(readFileSync2(resolveSetupDoc(), "utf8").trimEnd());
  });
  program.command("example").summary("copy a packaged example app into the workspace").description(
    "Copy a packaged example mini app into the workspace: `mdc example kanban` copies it to <root>/apps/kanban (run from the workspace root, or pass --into). Open the copied .html in mdc and trust it to run. Run with no name to list the available examples."
  ).argument("[name]", "example to copy (omit to list)").option("--into <dir>", "workspace root to copy into", ".").action(function(name, opts) {
    const root = resolveExamplesRoot();
    const names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    if (!name) {
      console.log("available examples:");
      for (const n of names) console.log("  " + n);
      console.log("copy one into the workspace: mdc example <name>");
      return;
    }
    if (!names.includes(name)) {
      throw new CliError(`unknown example '${name}' \u2014 available: ${names.join(", ")}`);
    }
    const dest = join2(resolvePath(opts.into), "apps", name);
    if (existsSync(dest)) {
      throw new CliError(`already exists: ${dest} \u2014 remove it to re-copy`);
    }
    cpSync(join2(root, name), dest, { recursive: true });
    console.log(`copied ${name} to ${dest}`);
    console.log("open it in mdc and trust it to run.");
  });
  return program;
}
function resolveExamplesRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join2(dir, "examples", "apps");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError("could not locate examples/apps in the package");
}
function resolveSetupDoc() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join2(dir, "docs", "agent-setup.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError("could not locate docs/agent-setup.md in the package");
}
async function main(argv) {
  let exitCode = 0;
  const program = buildProgram((code) => {
    exitCode = code;
  });
  program.exitOverride();
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      return e.exitCode;
    }
    if (e instanceof CliError) {
      console.error(`error: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
  return exitCode;
}
var isDirectRun = (() => {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
export {
  buildProgram,
  main,
  resolveServeRoot
};
