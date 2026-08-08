/**
 * Tests for the workspace launchers — which process gets spawned for which
 * combination of app_window preference, platform, and Chrome availability.
 * All process access goes through the injectable LaunchEnv; nothing real is
 * spawned.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkspaceWindow, readAppWindowConfig, type LaunchEnv } from "../src/launch.js";

/**
 * A fake spawn that records calls and immediately "exits" — with 0, or with
 * whatever `exitFor` returns for the call's args.
 */
function fakeSpawn(calls: string[][], exitFor: (args: string[]) => number = () => 0) {
  return ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return {
      on(event: string, cb: (code?: number) => void) {
        if (event === "exit") queueMicrotask(() => cb(exitFor(args)));
      },
    };
  }) as unknown as LaunchEnv["spawnFn"];
}

function fakeSpawnSync(status: number) {
  return (() => ({ status })) as unknown as LaunchEnv["spawnSyncFn"];
}

const URL = "http://localhost:8000";

describe("openWorkspaceWindow", () => {
  it("launches nothing when noBrowser is set", async () => {
    const calls: string[][] = [];
    await openWorkspaceWindow(URL, true, {
      noBrowser: true,
      platform: "darwin",
      spawnFn: fakeSpawn(calls),
      spawnSyncFn: fakeSpawnSync(0),
    });
    expect(calls).toEqual([]);
  });

  it("launches a Chrome app window when opted in and Chrome is installed", async () => {
    const calls: string[][] = [];
    await openWorkspaceWindow(URL, true, {
      noBrowser: false,
      platform: "darwin",
      spawnFn: fakeSpawn(calls),
      spawnSyncFn: fakeSpawnSync(0),
    });
    expect(calls).toEqual([["open", "-na", "Google Chrome", "--args", `--app=${URL}`]]);
  });

  it("falls back to the default browser when Chrome is not installed", async () => {
    const calls: string[][] = [];
    await openWorkspaceWindow(URL, true, {
      noBrowser: false,
      platform: "darwin",
      spawnFn: fakeSpawn(calls),
      spawnSyncFn: fakeSpawnSync(1),
    });
    expect(calls).toEqual([["open", URL]]);
  });

  it("ignores the opt-in off macOS", async () => {
    const calls: string[][] = [];
    await openWorkspaceWindow(URL, true, {
      noBrowser: false,
      platform: "linux",
      spawnFn: fakeSpawn(calls),
      spawnSyncFn: fakeSpawnSync(0),
    });
    expect(calls).toEqual([["xdg-open", URL]]);
  });

  it("opens a plain browser tab when not opted in", async () => {
    const calls: string[][] = [];
    await openWorkspaceWindow(URL, false, {
      noBrowser: false,
      platform: "darwin",
      spawnFn: fakeSpawn(calls),
      spawnSyncFn: fakeSpawnSync(0),
    });
    expect(calls).toEqual([["open", URL]]);
  });

  it("falls back to the default browser when the app-window launch fails", async () => {
    const calls: string[][] = [];
    await openWorkspaceWindow(URL, true, {
      noBrowser: false,
      platform: "darwin",
      // The app-window `open -na` attempt fails; the plain fallback succeeds.
      spawnFn: fakeSpawn(calls, (args) => (args.includes("-na") ? 1 : 0)),
      spawnSyncFn: fakeSpawnSync(0),
    });
    expect(calls).toEqual([
      ["open", "-na", "Google Chrome", "--args", `--app=${URL}`],
      ["open", URL],
    ]);
  });
});

describe("readAppWindowConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mdc-launch-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads app_window = true", () => {
    writeFileSync(join(dir, ".mdc.toml"), "app_window = true\n");
    expect(readAppWindowConfig(dir)).toBe(true);
  });

  it("is false when set to false, absent, non-boolean, missing, or malformed", () => {
    writeFileSync(join(dir, ".mdc.toml"), "app_window = false\n");
    expect(readAppWindowConfig(dir)).toBe(false);
    writeFileSync(join(dir, ".mdc.toml"), 'user = "odie"\n');
    expect(readAppWindowConfig(dir)).toBe(false);
    writeFileSync(join(dir, ".mdc.toml"), 'app_window = "yes"\n');
    expect(readAppWindowConfig(dir)).toBe(false);
    rmSync(join(dir, ".mdc.toml"));
    expect(readAppWindowConfig(dir)).toBe(false);
    writeFileSync(join(dir, ".mdc.toml"), "not [ valid toml\n");
    expect(readAppWindowConfig(dir)).toBe(false);
  });
});
