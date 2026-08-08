/**
 * Launchers that put a served workspace in front of the user — either a tab in
 * the OS default browser, or (opt-in) a chromeless Chrome app-mode window.
 *
 * The app window is gated on macOS + Chrome being installed (not necessarily
 * the default browser); every other case falls back to the default browser so
 * enabling `app_window` can never make a workspace unreachable.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CONFIG_FILENAME } from "./identity.js";

/** Injectable process layer for tests; defaults to the real platform/spawns. */
export interface LaunchEnv {
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
  spawnSyncFn?: typeof spawnSync;
  /** Suppress every browser launch; defaults to `MDC_NO_BROWSER=1`. */
  noBrowser?: boolean;
}

/**
 * The `app_window` flag from `<root>/.mdc.toml`, defaulting false. Root config
 * only — it's a workspace preference, unlike identity, which prefers the
 * user's home config. Best-effort like the identity read: a missing file,
 * malformed TOML, or non-boolean value is just "off", never an error.
 */
export function readAppWindowConfig(root: string): boolean {
  let text: string;
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

/** Spawn the OS's default URL opener (browser) for `url`. */
async function openInBrowser(url: string, env: LaunchEnv = {}): Promise<void> {
  const spawnFn = env.spawnFn ?? spawn;
  const opener =
    (env.platform ?? process.platform) === "darwin"
      ? ["open", url]
      : (env.platform ?? process.platform) === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  await new Promise<void>((res, rej) => {
    const p = spawnFn(opener[0]!, opener.slice(1), { stdio: "ignore" });
    p.on("error", rej);
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
  });
}

/**
 * Open `url` the way the workspace asked for: a Chrome app-mode window when
 * `appWindow` is set and Chrome is installed (macOS only), else a default-
 * browser tab. App-window failures fall back to the tab rather than throwing —
 * the launch mode is a preference, reaching the workspace is the contract.
 */
export async function openWorkspaceWindow(
  url: string,
  appWindow: boolean,
  env: LaunchEnv = {},
): Promise<void> {
  // MDC_NO_BROWSER=1 — the workspace is being viewed in an embedded browser
  // (a Claude Code / editor preview pane) that the caller drives itself, so
  // launching a system browser puts the review in the wrong window. Every
  // launch path reaches this function, including `mdc open`'s fallback when no
  // client is attached to the port, which `serve --no-open` does not cover.
  const noBrowser = env.noBrowser ?? process.env.MDC_NO_BROWSER === "1";
  if (noBrowser) {
    console.log(`mdc: not launching a browser (MDC_NO_BROWSER=1) — open ${url}`);
    return;
  }
  const platform = env.platform ?? process.platform;
  const spawnSyncFn = env.spawnSyncFn ?? spawnSync;
  if (appWindow && platform === "darwin") {
    const chromeInstalled =
      spawnSyncFn("open", ["-Ra", "Google Chrome"], { stdio: "ignore" }).status === 0;
    if (chromeInstalled) {
      const spawnFn = env.spawnFn ?? spawn;
      const ok = await new Promise<boolean>((res) => {
        const p = spawnFn("open", ["-na", "Google Chrome", "--args", `--app=${url}`], {
          stdio: "ignore",
        });
        p.on("error", () => res(false));
        p.on("exit", (code) => res(code === 0));
      });
      if (ok) return;
    }
  }
  await openInBrowser(url, env);
}
