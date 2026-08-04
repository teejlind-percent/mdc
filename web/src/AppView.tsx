/**
 * Trusted-app view: a trusted HTML file run as a mini app inside mdc.
 *
 * Unlike the view-only HtmlView (`sandbox=""`, opaque + scriptless), this frame
 * is `sandbox="allow-scripts"`: scripts run, but the origin stays opaque (no
 * `allow-same-origin`), so the app still can't reach the parent DOM or call
 * mdc's API directly. NEVER add `allow-same-origin` here — combined with
 * `allow-scripts` it lets the page drop its own sandbox.
 *
 * The injected `window.mdc` bridge (app-bridge.ts) posts requests to the parent;
 * the handler here performs the real /api/app/* call and posts the result back.
 * The parent is the single gate through which all file access flows.
 *
 * The sandbox also withholds `allow-popups`, so an app can't open a tab itself;
 * external links go through `openUrl` here, where the scheme is checked first
 * (docs/adr/0005). Keep it that way — the gate only works if it's the only door.
 */

import { useEffect, useRef, useState } from "react";
import { AppPermissionCard } from "./AppPermissionCard.js";
import { APP_BRIDGE_SOURCE, type BridgeRequest, type BridgeReply, type BridgeNotify } from "./app-bridge.js";
import { ApiError, fetchAppInfo, fetchHtmlFile } from "./api.js";
import { isBeyondFolder, vetExternalUrl } from "./app-scope.js";

/** Cap on a single app's persisted state blob — sessionStorage is small, and
 * this is opaque UI state, not a data store. */
const MAX_APP_STATE_BYTES = 1_000_000;

/** sessionStorage key for an app's persisted state, namespaced by app path so
 * apps can't read each other's blob. */
function stateKey(appPath: string): string {
  return `mdc.appstate:${appPath}`;
}

/** sessionStorage key marking that the user chose "Always allow" for this app's
 * cross-folder writes. Set = no further write-grant prompts this session.
 * Survives ⌘R; cleared when the browser session ends (re-confirm next session). */
function writeGrantKey(appPath: string): string {
  return `mdc.writegrant:${appPath}`;
}
function hasWriteGrant(appPath: string): boolean {
  try {
    return sessionStorage.getItem(writeGrantKey(appPath)) !== null;
  } catch {
    return false;
  }
}
function setWriteGrant(appPath: string): void {
  try {
    sessionStorage.setItem(writeGrantKey(appPath), "1");
  } catch {
    /* sessionStorage unavailable → grant just won't persist; confirm re-fires */
  }
}

/** The user's choice on a write-grant prompt. */
type GrantChoice = "once" | "always" | "deny";

/** A pending cross-folder-write confirmation: the target path and the resolver
 * the bridge handler is awaiting. Rendered as a parent-drawn card (the sandbox
 * has no native confirm()). */
interface ConfirmReq {
  path: string;
  resolve: (choice: GrantChoice) => void;
}

/** Build the iframe document: the app's HTML with the bridge injected first. */
function withBridge(html: string): string {
  const tag = `<script>${APP_BRIDGE_SOURCE}</script>`;
  // Inject right after <head> if present, else prepend so the bridge defines
  // window.mdc before the app's own scripts run.
  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen) {
    const at = (headOpen.index ?? 0) + headOpen[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

export function AppView({
  file,
  reloadNonce,
  onRawContentLoaded,
}: {
  file: string;
  reloadNonce: number;
  onRawContentLoaded?: (file: string, raw: string) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appName, setAppName] = useState<string | null>(null);
  // A pending cross-folder-write confirmation, or null when none is showing.
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const rawLoadedCb = useRef(onRawContentLoaded);
  rawLoadedCb.current = onRawContentLoaded;

  // The app's display name for the write-grant card title (best-effort).
  useEffect(() => {
    let cancelled = false;
    fetchAppInfo(file).then(
      (i) => !cancelled && setAppName(i.name),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Load the app HTML (and reload on banner Reload / file switch).
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    fetchHtmlFile(file)
      .then((text) => {
        if (cancelled) return;
        setHtml(withBridge(text));
        // The app's own source, before the bridge is injected: Copy contents
        // yields the file as authored, not mdc's runtime wrapper.
        rawLoadedCb.current?.(file, text);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Could not load this app");
      });
    return () => {
      cancelled = true;
    };
  }, [file, reloadNonce]);

  // Parent-side bridge: handle requests from THIS frame, post replies back.
  useEffect(() => {
    async function handle(req: BridgeRequest): Promise<unknown> {
      const { method, args } = req;
      if (method === "getAppInfo") {
        return fetchAppInfo(file);
      }
      if (method === "readText") {
        const path = String(args[0] ?? "");
        const r = await fetch(
          `/api/app/read?app=${encodeURIComponent(file)}&path=${encodeURIComponent(path)}`,
        );
        if (!r.ok) throw new Error((await r.text()) || `read failed: ${path}`);
        return r.json();
      }
      if (method === "writeText") {
        const path = String(args[0] ?? "");
        const content = String(args[1] ?? "");
        // Write-grant confirm: the first cross-folder write this session prompts
        // the user (the security boundary is already enforced server-side by
        // canWrite + trust; this is a moment-of-action checkpoint). Own-folder
        // writes never prompt, and "Always allow" suppresses it for the session.
        if (isBeyondFolder(file, path) && !hasWriteGrant(file)) {
          const choice = await new Promise<GrantChoice>((resolve) => {
            setConfirmReq({ path, resolve });
          });
          setConfirmReq(null);
          if (choice === "deny") throw new Error(`write declined by user: ${path}`);
          if (choice === "always") setWriteGrant(file);
          // "once" / "always" → fall through to the write.
        }
        // Optional conflict token: when the app passes the version it last read,
        // the server rejects (409) if the file changed underneath. Omitted → a
        // blind write. Only include it in the body when actually supplied.
        const baseVersion = args[2];
        const payload: { content: string; baseVersion?: string } = { content };
        if (typeof baseVersion === "string") payload.baseVersion = baseVersion;
        const r = await fetch(
          `/api/app/write?app=${encodeURIComponent(file)}&path=${encodeURIComponent(path)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!r.ok) {
          // Surface the server's message (e.g. the 409 "changed underneath you")
          // so the app's catch sees a clear, actionable error.
          const detail = await r.text();
          throw new Error(detail || `write failed: ${path}`);
        }
        return r.json();
      }
      if (method === "deleteFile") {
        const path = String(args[0] ?? "");
        // Deleting is a write: the same cross-folder write-grant checkpoint
        // applies (own-folder deletes never prompt; "Always allow" suppresses it
        // for the session). The server enforces canWrite + trust regardless.
        if (isBeyondFolder(file, path) && !hasWriteGrant(file)) {
          const choice = await new Promise<GrantChoice>((resolve) => {
            setConfirmReq({ path, resolve });
          });
          setConfirmReq(null);
          if (choice === "deny") throw new Error(`delete declined by user: ${path}`);
          if (choice === "always") setWriteGrant(file);
        }
        const r = await fetch(
          `/api/app/delete?app=${encodeURIComponent(file)}&path=${encodeURIComponent(path)}`,
          { method: "DELETE" },
        );
        if (!r.ok) throw new Error((await r.text()) || `delete failed: ${path}`);
        return r.json();
      }
      if (method === "listFiles") {
        const path = String(args[0] ?? "");
        const opts = (args[1] ?? {}) as { recursive?: boolean };
        const rec = opts.recursive ? "&recursive=1" : "";
        const r = await fetch(
          `/api/app/list?app=${encodeURIComponent(file)}&path=${encodeURIComponent(path)}${rec}`,
        );
        if (!r.ok) throw new Error((await r.text()) || `list failed: ${path}`);
        return r.json();
      }
      if (method === "readFrontmatter") {
        const path = String(args[0] ?? "");
        const opts = (args[1] ?? {}) as { recursive?: boolean };
        const rec = opts.recursive ? "&recursive=1" : "";
        const r = await fetch(
          `/api/app/read-frontmatter?app=${encodeURIComponent(file)}&path=${encodeURIComponent(path)}${rec}`,
        );
        if (!r.ok) throw new Error((await r.text()) || `read frontmatter failed: ${path}`);
        return r.json();
      }
      if (method === "openFile") {
        // Navigational, not file I/O: ask mdc to open a file (switch to
        // its tab if open, else add one). No scope check — it opens a tab, grants
        // no read/write the app doesn't already have via the bridge.
        const path = String(args[0] ?? "");
        const r = await fetch("/api/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: path }),
        });
        if (!r.ok) throw new Error((await r.text()) || `open failed: ${path}`);
        return r.json();
      }
      if (method === "openUrl") {
        // Outbound navigation, mediated: the app can't open a tab itself (the
        // sandbox withholds allow-popups precisely so it can't), so it asks the
        // parent. The scheme allowlist is the only control here — the app is
        // already trusted, so there's no prompt — which is why it denies by
        // default: javascript:/data: URLs would run code or smuggle content
        // out of the frame's opaque origin. See docs/adr/0005.
        const href = vetExternalUrl(String(args[0] ?? ""));
        // noopener keeps the new tab from reaching back via window.opener.
        window.open(href, "_blank", "noopener,noreferrer");
        return { opened: true };
      }
      if (method === "getState") {
        // Parent-persisted, per-app opaque state. The parent is same-origin and
        // persistent; the app's opaque-origin frame has no web storage of its
        // own, so it stashes UI state here. Survives mdc's tab-switch remount and
        // in-session reloads; cleared when the browser session ends.
        try {
          const raw = sessionStorage.getItem(stateKey(file));
          return raw === null ? null : JSON.parse(raw);
        } catch {
          return null; // absent or corrupt → no state, never throw
        }
      }
      if (method === "setState") {
        let serialized: string;
        try {
          serialized = JSON.stringify(args[0]);
        } catch {
          throw new Error("state is not serializable");
        }
        if (serialized.length > MAX_APP_STATE_BYTES) {
          throw new Error("state too large (max 1 MB)");
        }
        try {
          sessionStorage.setItem(stateKey(file), serialized);
        } catch {
          throw new Error("could not persist state");
        }
        return { saved: true };
      }
      throw new Error(`unknown bridge method: ${method}`);
    }

    function onMessage(e: MessageEvent): void {
      const d = e.data as BridgeRequest | undefined;
      if (!d || d.mdcBridge !== true) return;
      // Reply to the window that sent the request. We identify the sender by the
      // `mdcBridge` marker + replying to `e.source` (the live sending window)
      // rather than matching frameRef.current — the ref can be momentarily null
      // during React's commit when srcDoc changes, which dropped early requests.
      const source = e.source as Window | null;
      if (!source) return;

      handle(d).then(
        (result) =>
          source.postMessage(
            { mdcBridgeReply: true, id: d.id, ok: true, result } satisfies BridgeReply,
            "*",
          ),
        (err: unknown) =>
          source.postMessage(
            {
              mdcBridgeReply: true,
              id: d.id,
              ok: false,
              error: err instanceof Error ? err.message : "bridge error",
            } satisfies BridgeReply,
            "*",
          ),
      );
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [file]);

  // Live updates: subscribe to in-scope workspace changes for this app and push
  // a coarse notify into the frame (window.mdc.watch callbacks fire → the app
  // re-reads). The server stream is already scope-filtered (canRead); we just
  // debounce a burst into one notify so a multi-file change = one app reload.
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const notify = () => {
      // Push only to OUR frame. contentWindow can be momentarily null during a
      // srcDoc commit; a dropped notify is harmless (the next change re-fires,
      // and the app reloads fresh on mount anyway).
      const msg: BridgeNotify = { mdcBridgeNotify: true, kind: "changed" };
      frameRef.current?.contentWindow?.postMessage(msg, "*");
    };

    const connect = () => {
      if (closed) return;
      const src = new EventSource(`/api/app/watch?app=${encodeURIComponent(file)}`);
      es = src;
      src.addEventListener("changed", () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(notify, 200); // debounce a burst into one notify
      });
      src.onerror = () => {
        src.close();
        if (es === src) es = null;
        if (!closed) setTimeout(connect, 2000); // reconnect with backoff
      };
    };
    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [file]);

  if (error) return <div className="doc doc-error">Could not load this app: {error}</div>;
  if (html === null) return <div className="doc html-view" />;

  return (
    <div className="doc html-view">
      <iframe
        ref={frameRef}
        className="html-frame"
        title={file}
        sandbox="allow-scripts"
        srcDoc={html}
      />
      {confirmReq && (
        <WriteGrantPrompt
          appName={appName}
          path={confirmReq.path}
          onChoose={confirmReq.resolve}
        />
      )}
    </div>
  );
}

/**
 * The moment-of-action confirm for a cross-folder write. Drawn as mdc chrome
 * over the app frame (the sandbox has no native confirm()), reusing the
 * app-trust card vocabulary. The app's writeText promise is suspended until the
 * user chooses: Allow once (this write), Always allow (no more prompts this
 * session), or Deny (the write rejects).
 */
function WriteGrantPrompt({
  appName,
  path,
  onChoose,
}: {
  appName: string | null;
  path: string;
  onChoose: (choice: GrantChoice) => void;
}) {
  return (
    <div className="app-trust app-write-grant">
      <AppPermissionCard
        title={appName ? `“${appName}” wants to write a file` : "This app wants to write a file"}
        body={
          <>
            This write is <strong>outside the app's own folder</strong>:
          </>
        }
        scopes={[{ label: "Write", value: <code>{path}</code> }]}
        actions={
          <>
            <button type="button" className="app-trust-run" onClick={() => onChoose("once")}>
              Allow once
            </button>
            <button type="button" className="app-grant-always" onClick={() => onChoose("always")}>
              Always allow
            </button>
            <button type="button" className="app-grant-deny" onClick={() => onChoose("deny")}>
              Deny
            </button>
          </>
        }
        footnote="“Always allow” is remembered until you close this browser session."
        onCancel={() => onChoose("deny")}
      />
    </div>
  );
}
