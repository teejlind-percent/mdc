import { describe, expect, it } from "vitest";
import { vetExternalUrl } from "./app-scope.js";

describe("vetExternalUrl", () => {
  it("passes the allowed schemes through", () => {
    expect(vetExternalUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(vetExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(vetExternalUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it("refuses schemes that would run code or carry inline content", () => {
    // The whole point of the allowlist: an app is trusted to ask, not to smuggle.
    expect(() => vetExternalUrl("javascript:alert(1)")).toThrow(/refusing to open/);
    expect(() => vetExternalUrl("data:text/html,<h1>hi</h1>")).toThrow(/refusing to open/);
    expect(() => vetExternalUrl("blob:https://example.com/uuid")).toThrow(/refusing to open/);
    expect(() => vetExternalUrl("file:///etc/passwd")).toThrow(/refusing to open/);
  });

  it("refuses anything that isn't an absolute URL", () => {
    // No base to resolve against — the app frame is opaque-origin.
    expect(() => vetExternalUrl("/docs/guide.md")).toThrow(/not a valid absolute URL/);
    expect(() => vetExternalUrl("example.com")).toThrow(/not a valid absolute URL/);
    expect(() => vetExternalUrl("")).toThrow(/not a valid absolute URL/);
  });

  it("is not fooled by scheme casing or leading whitespace", () => {
    expect(vetExternalUrl("HTTPS://example.com/x")).toBe("https://example.com/x");
    expect(vetExternalUrl("  https://example.com/x  ")).toBe("https://example.com/x");
    expect(() => vetExternalUrl("JavaScript:alert(1)")).toThrow(/refusing to open/);
    expect(() => vetExternalUrl("\njavascript:alert(1)")).toThrow(/refusing to open/);
  });
});
