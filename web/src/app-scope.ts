/**
 * App-scope path helpers shared by the trust prompt (HtmlSurface) and the
 * write-grant confirm (AppView). One definition of "the app's own folder" and
 * "reaches beyond it" so the two surfaces can't drift apart.
 *
 * All paths are root-relative posix strings (the same shape the bridge uses).
 *
 * Also home to the outbound-URL check, the other edge of an app's reach.
 */

/** The app's own folder, root-relative ("" for a root-level app). */
export function ownFolder(appPath: string): string {
  return appPath.includes("/") ? appPath.slice(0, appPath.lastIndexOf("/")) : "";
}

/** True if `target` sits inside `folder` (or `folder` is the workspace root). */
function isWithinFolder(folder: string, target: string): boolean {
  return folder === "" || target === folder || target.startsWith(folder + "/");
}

/** True if `target` reaches BEYOND the app's own folder (a cross-folder path). */
export function isBeyondFolder(appPath: string, target: string): boolean {
  return !isWithinFolder(ownFolder(appPath), target);
}

/** The manifest scopes that reach beyond the app's own folder (worth naming). */
export function beyondFolder(scopes: string[], appPath: string): string[] {
  const folder = ownFolder(appPath);
  return scopes.filter((s) => !isWithinFolder(folder, s));
}

/** Schemes `mdc.openUrl` will open, as URL.protocol values. Deny-by-default:
 * this is the only gate on an app's outbound navigation, so anything that could
 * run code (javascript:) or carry inline content (data:, blob:) stays off it. */
const ALLOWED_URL_SCHEMES = new Set(["https:", "http:", "mailto:"]);

/**
 * Vet a URL an app asked mdc to open. Returns the normalized absolute URL, or
 * throws with the reason — the caller surfaces that as the bridge rejection.
 * Relative URLs are rejected outright: the app frame is opaque-origin, so there
 * is no meaningful base to resolve them against.
 */
export function vetExternalUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`not a valid absolute URL: ${raw}`);
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`refusing to open ${parsed.protocol} URL (allowed: https, http, mailto)`);
  }
  return parsed.href;
}
