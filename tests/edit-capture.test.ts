/**
 * Edit capture — the diff that turns a human's direct edits into review
 * threads. Line-based, because a reworded sentence should read as one change.
 */

import { describe, expect, it } from "vitest";
import { diffEdits, hunkBody } from "../src/edit-capture.js";

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
