import { describe, expect, it } from "vitest";
import { fuzzyFind } from "../src/anchor.js";
import { renderMarkdown } from "../web/src/render/markdown.js";
import { resolveLine } from "../web/src/render/createAnchor.js";

describe("markdown rendering", () => {
  it("closes self-closing non-void HTML tags so later markdown remains outside them", () => {
    const html = renderMarkdown(`Text above.

<iframe src="https://example.com/video" style={{ width: 560 }} allowFullScreen />

Text below.

## Heading below
`);

    expect(html).toContain(
      '<iframe src="https://example.com/video" style={{ width: 560 }} allowFullScreen></iframe>',
    );
    expect(html).toContain("<p>Text below.</p>");
    expect(html).toContain('<h2 id="heading-below">Heading below</h2>');
    expect(html.indexOf("</iframe>")).toBeLessThan(html.indexOf("<p>Text below.</p>"));
  });

  it("preserves void HTML tags and escaped code samples", () => {
    const html = renderMarkdown(`Before<br />

\`\`\`html
<iframe src="https://example.com/video" />
\`\`\`
`);

    expect(html).toContain("Before<br />");
    expect(html).toContain("&lt;");
    expect(html).toContain("iframe");
    expect(html).toContain("/&gt;");
    expect(html).not.toContain("</iframe>");
  });

  it("keeps completed lists and setext headings in their CommonMark shapes", () => {
    expect(renderMarkdown("text\n- x")).toContain("<ul>");
    expect(renderMarkdown("text\n---")).toContain('<h2 id="text">text</h2>');
  });

  it("requires double tildes for strikethrough", () => {
    const html = renderMarkdown(`~~struck~~

~single~

~L42

a ~ b

\`~inline~\`

\`\`\`
~fenced~
\`\`\`
`);

    expect(html).toContain("<del>struck</del>");
    expect(html).toContain("<p>~single~</p>");
    expect(html).toContain("<p>~L42</p>");
    expect(html).toContain("<p>a ~ b</p>");
    expect(html).toContain("<code>~inline~</code>");
    expect(html).toContain("<pre><code>~fenced~</code></pre>");
    expect(html).not.toContain("<del>single</del>");
    expect(html).not.toContain("<del>L42</del>");
    expect(html).not.toContain("<del>inline</del>");
    expect(html).not.toContain("<del>fenced</del>");
  });

  // Nested list items must parse as a real nested list regardless of whether the
  // child is indented with two spaces, a tab, or four spaces — real docs mix
  // these, and a broken parse changes the DOM the list CSS depends on.
  it.each([
    ["two spaces", "- [ ] parent\n  - [ ] child\n  - bullet\n"],
    ["a tab", "- [ ] parent\n\t- [ ] child\n\t- bullet\n"],
    ["four spaces", "- [ ] parent\n    - [ ] child\n    - bullet\n"],
  ])("nests a child list indented with %s", (_label, md) => {
    const html = renderMarkdown(md);
    // A nested list = a <ul> that appears inside a parent <li>.
    expect(/<li[^>]*>[\s\S]*?<ul/.test(html)).toBe(true);
  });
});

describe("hard-wrapped prose", () => {
  const wrapped = [
    "This is a hard-wrapped paragraph where the author",
    "pressed enter at a natural column, the way most",
    "markdown files in the workspace are written.",
  ].join("\n");

  it("treats a single newline as a soft wrap, not a line break", () => {
    const html = renderMarkdown(`${wrapped}\n`);
    expect(html).not.toContain("<br>");
    // The newline survives as real whitespace, so the browser collapses it for
    // display and textContent keeps a separator between the words.
    expect(html).toContain("where the author\npressed enter");
  });

  it("keeps a selection spanning a wrap point matchable against the raw source", () => {
    // textContent, as the browser computes it: tags contribute nothing, so a
    // <br> leaves NO separator between the words on either side of it.
    const textContent = (html: string) => html.replace(/<[^>]+>/g, "").trim();
    const rendered = textContent(renderMarkdown(`${wrapped}\n`));
    // What the browser hands back for a selection across the wrap point.
    const quote = rendered.slice(
      rendered.indexOf("where the author"),
      rendered.indexOf("pressed enter") + "pressed enter".length,
    );
    // Words must not be glued together — <br> contributes nothing to
    // textContent, which is what broke anchoring.
    expect(quote).not.toContain("authorpressed");
    expect(fuzzyFind(wrapped, quote)).not.toBeNull();
    expect(resolveLine(wrapped, quote, rendered)).toBe(1);
  });

  it("still honours explicit hard breaks", () => {
    expect(renderMarkdown("One.  \nTwo.\n")).toContain("<br>");
    expect(renderMarkdown("One.\\\nTwo.\n")).toContain("<br>");
  });
});
