import { describe, expect, it } from "vitest";
import {
  getTextPreviewDescriptor,
  highlightCodeLine,
  isSupportedTextPreviewFile,
} from "../../src/lib/codePreview";

describe("code preview helpers", () => {
  it("recognizes common code, script, and config filenames", () => {
    expect(isSupportedTextPreviewFile("script.py")).toBe(true);
    expect(isSupportedTextPreviewFile("deploy.sh")).toBe(true);
    expect(isSupportedTextPreviewFile("Dockerfile")).toBe(true);
    expect(isSupportedTextPreviewFile(".env.local")).toBe(true);
    expect(isSupportedTextPreviewFile(".gitignore")).toBe(true);
  });

  it("returns code descriptors for syntax-aware previews", () => {
    expect(getTextPreviewDescriptor("main.rs")).toMatchObject({
      kind: "code",
      label: "Rust",
      language: "rust",
    });
    expect(getTextPreviewDescriptor("script.ps1")).toMatchObject({
      kind: "code",
      label: "PowerShell",
      language: "powershell",
    });
  });

  it("highlights keywords, strings, and comments", () => {
    const html = highlightCodeLine(
      'const title = "tidy"; // preview',
      "javascript",
    );
    expect(html).toContain('class="token-keyword"');
    expect(html).toContain('class="token-string"');
    expect(html).toContain('class="token-comment"');
  });
});
