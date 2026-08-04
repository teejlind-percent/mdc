/**
 * The `window.mdc` bridge injected into a trusted app frame.
 *
 * A trusted app runs in a sandboxed iframe (scripts allowed, but an opaque
 * origin: it can't reach the parent's DOM or call mdc's API directly). Its only
 * channel out is postMessage. This script — injected into the frame's document
 * — defines `window.mdc`, whose methods post a request to the parent and resolve
 * when the matching reply arrives. The PARENT performs every real file
 * operation and permission check; the app never touches the filesystem itself.
 *
 * Exported as a string so the frontend can inline it into the iframe's srcdoc.
 * It is self-contained (no imports, no module scope) — it runs as a classic
 * script inside the untrusted frame.
 */

/** The wire shape of a bridge request (frame → parent). */
export interface BridgeRequest {
  mdcBridge: true;
  id: number;
  method: string;
  args: unknown[];
}

/** The wire shape of a bridge reply (parent → frame). */
export interface BridgeReply {
  mdcBridgeReply: true;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * An unsolicited push from parent → frame (not a reply to a request). Used by
 * `window.mdc.watch`: the parent fires this when an in-scope workspace file
 * changes, and the bridge invokes the app's registered callbacks. Coarse by
 * design — it carries no path; the app re-reads its own data.
 */
export interface BridgeNotify {
  mdcBridgeNotify: true;
  kind: "changed";
}

/**
 * The injected source. Kept as a template string (not a real function) because
 * it must run in the frame's own global scope, not the app bundle's. The
 * origin is `null` under `sandbox="allow-scripts"`, so postMessage uses `*`.
 */
export const APP_BRIDGE_SOURCE = `
(function () {
  var seq = 0;
  var pending = {};
  var watchers = [];

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d) return;
    if (d.mdcBridgeNotify === true) {
      // Unsolicited push: an in-scope file changed. Fan out to every watcher;
      // an error in one callback must not block the others.
      for (var i = 0; i < watchers.length; i++) {
        try { watchers[i](); } catch (err) { /* swallow */ }
      }
      return;
    }
    if (d.mdcBridgeReply !== true) return;
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    if (d.ok) p.resolve(d.result);
    else p.reject(new Error(d.error || "mdc bridge error"));
  });

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage(
        { mdcBridge: true, id: id, method: method, args: args || [] },
        "*"
      );
    });
  }

  window.mdc = {
    readText: function (path) { return call("readText", [path]); },
    writeText: function (path, content, baseVersion) { return call("writeText", [path, content, baseVersion]); },
    deleteFile: function (path) { return call("deleteFile", [path]); },
    listFiles: function (path, opts) { return call("listFiles", [path, opts]); },
    readFrontmatter: function (path, opts) { return call("readFrontmatter", [path, opts]); },
    getAppInfo: function () { return call("getAppInfo", []); },
    openFile: function (path) { return call("openFile", [path]); },
    openUrl: function (url) { return call("openUrl", [url]); },
    getState: function () { return call("getState", []); },
    setState: function (state) { return call("setState", [state]); },
    watch: function (cb) {
      if (typeof cb !== "function") return function () {};
      watchers.push(cb);
      return function unsubscribe() {
        var i = watchers.indexOf(cb);
        if (i !== -1) watchers.splice(i, 1);
      };
    },
  };
})();
`;
