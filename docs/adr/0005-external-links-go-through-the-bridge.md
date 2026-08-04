# External links go through the bridge

A mini app opens an external link by calling `window.mdc.openUrl(url)`; the parent validates the scheme and opens the tab. The app frame's sandbox stays `allow-scripts` and nothing more.

The alternative was adding `allow-popups` (plus `allow-popups-to-escape-sandbox`, since a popup otherwise inherits the sandbox and lands somewhere just as useless) to the iframe. That is one attribute token against a whole bridge method, and it makes plain `<a target="_blank">` work with no app changes at all — genuinely the cheaper option. It was rejected because it hands the app an unmediated exit: `window.open` would accept any URL, including `javascript:` and `data:`, and mdc would never see the destination. Every other app capability — read, write, delete, list, open a workspace file — is a request the parent performs on the app's behalf, and the frame's opaque origin plus the deny-by-default sandbox is what makes that the *only* path out. A popup hole is a second path, permanently, for a one-line convenience.

So: deny-by-default on schemes (`https:`, `http:`, `mailto:` pass; everything else rejects), and the sandbox attribute remains a thing we only ever remove tokens from.

## Consequences

- `openUrl` does not prompt. Trust is already granted per exact app version (content-hash-keyed), and a confirmation on every link makes ordinary links feel broken — the same reasoning that leaves own-folder writes silent. This is the one place an app acts outward without a checkpoint, so the scheme allowlist is the whole control; widening it is a trust-model change, not a tweak.
- A rejected URL rejects the promise, like every other out-of-scope or denied bridge call. App authors already wrap bridge calls in try/catch; no new failure pattern to learn.
- The parent's `window.open` runs from a postMessage handler, not a user gesture the browser can see, so a popup blocker may swallow it. mdc cannot distinguish "blocked" from "opened" reliably across browsers; the app gets a resolved promise either way. If this proves to bite in practice, the fix is a parent-drawn affordance (mdc chrome the user clicks), not loosening the sandbox.
- `<a href="https://…" target="_blank">` still does nothing inside an app. Links must be wired to `openUrl` explicitly. That cost is accepted: it is what keeps the parent the single gate.
