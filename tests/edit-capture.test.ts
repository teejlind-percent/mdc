/**
 * Edit capture — the diff that turns a human's direct edits into review
 * threads. Line-based, because a reworded sentence should read as one change.
 */

import { describe, expect, it } from "vitest";
import { CaptureBuffer, diffEdits, hunkBody } from "../src/edit-capture.js";

const DOC = ["# Title", "", "First paragraph here.", "", "Second paragraph here.", ""].join("\n");

describe("diffEdits", () => {
  it("returns nothing for an unchanged document", () => {
    expect(diffEdits(DOC, DOC)).toEqual([]);
  });

  it("captures a reworded line as one hunk anchored to the new text", () => {
    const after = DOC.replace("First paragraph here.", "First paragraph, revised.");
    const hunks = diffEdits(DOC, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      quote: "First paragraph, revised.",
      before: "First paragraph here.",
      after: "First paragraph, revised.",
    });
  });

  it("captures an insertion with no previous wording", () => {
    const after = DOC.replace("Second paragraph here.", "Inserted line.\n\nSecond paragraph here.");
    const hunks = diffEdits(DOC, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.before).toBe("");
    expect(hunks[0]!.after).toContain("Inserted line.");
  });

  it("anchors a deletion to surviving text, since its own text is gone", () => {
    const after = DOC.replace("Second paragraph here.\n", "");
    const hunks = diffEdits(DOC, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.after).toBe("");
    expect(hunks[0]!.before).toContain("Second paragraph here.");
    // must be findable in the document as it now stands
    expect(after).toContain(hunks[0]!.quote);
  });

  it("keeps separate edits as separate hunks", () => {
    const after = DOC.replace("First paragraph here.", "One.").replace(
      "Second paragraph here.",
      "Two.",
    );
    expect(diffEdits(DOC, after)).toHaveLength(2);
  });

  it("ignores whitespace-only churn", () => {
    expect(diffEdits(DOC, DOC + "\n\n")).toEqual([]);
  });

  it("always anchors to text present in the new document", () => {
    const after = ["# Title", "", "Wholly different body.", ""].join("\n");
    for (const h of diffEdits(DOC, after)) expect(after).toContain(h.quote);
  });
});

describe("hunkBody", () => {
  it("distinguishes edit, addition and deletion", () => {
    expect(hunkBody({ quote: "q", before: "a", after: "b" }, "TJ")).toContain("edited");
    expect(hunkBody({ quote: "q", before: "", after: "b" }, "TJ")).toContain("added");
    expect(hunkBody({ quote: "q", before: "a", after: "" }, "TJ")).toContain("deleted");
  });
});

describe("CaptureBuffer", () => {
  it("coalesces a burst of saves into one capture, keeping the pre-burst baseline", async () => {
    const fired: Array<[string, string]> = [];
    const buf = new CaptureBuffer((k, baseline) => fired.push([k, baseline]), 20);
    // one word typed a character at a time, the way autosave delivers it
    buf.note("doc.md", "the fund targets 12% net returns");
    buf.note("doc.md", "the fund targets 1 net returns");
    buf.note("doc.md", "the fund targets low net returns");
    expect(fired).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toHaveLength(1);
    // the baseline must be what stood BEFORE the burst, not a mid-edit state
    expect(fired[0]![1]).toBe("the fund targets 12% net returns");
  });

  it("starts a fresh baseline once a burst has settled", async () => {
    const fired: string[] = [];
    const buf = new CaptureBuffer((_k, baseline) => fired.push(baseline), 20);
    buf.note("doc.md", "one");
    await new Promise((r) => setTimeout(r, 60));
    buf.note("doc.md", "two");
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toEqual(["one", "two"]);
  });

  it("keeps separate files separate", async () => {
    const fired: string[] = [];
    const buf = new CaptureBuffer((k) => fired.push(k), 20);
    buf.note("a.md", "x");
    buf.note("b.md", "y");
    await new Promise((r) => setTimeout(r, 60));
    expect(fired.sort()).toEqual(["a.md", "b.md"]);
  });

  it("flush fires immediately and clear fires nothing", async () => {
    const fired: string[] = [];
    const buf = new CaptureBuffer((k) => fired.push(k), 10_000);
    buf.note("a.md", "x");
    buf.flush("a.md");
    expect(fired).toEqual(["a.md"]);
    buf.note("b.md", "y");
    buf.clear();
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toEqual(["a.md"]);
  });
});
