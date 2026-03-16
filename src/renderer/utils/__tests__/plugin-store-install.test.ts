import { describe, expect, it } from "vitest";

import { isGitPluginUrl } from "../plugin-store-install";

describe("isGitPluginUrl", () => {
  it("detects git URLs for known git install formats", () => {
    expect(isGitPluginUrl("git@github.com:owner/repo.git")).toBe(true);
    expect(isGitPluginUrl("github:owner/repo")).toBe(true);
    expect(isGitPluginUrl("https://github.com/owner/repo")).toBe(true);
    expect(isGitPluginUrl("https://github.com/owner/repo.git")).toBe(true);
  });

  it("does not misclassify manifest URLs that include github path segments", () => {
    expect(
      isGitPluginUrl("https://raw.githubusercontent.com/org/repo/main/ChatAndBuild.plugin.json"),
    ).toBe(false);
    expect(
      isGitPluginUrl("https://api.github.com/repos/org/repo/contents/ChatAndBuild.plugin.json"),
    ).toBe(false);
    expect(
      isGitPluginUrl("https://example.com/api/ChatAndBuild.github.com/manifest/ChatAndBuild.plugin.json"),
    ).toBe(false);
  });

  it("returns false for unsupported strings", () => {
    expect(isGitPluginUrl("")).toBe(false);
    expect(isGitPluginUrl("ChatAndBuild.pack.tar.gz")).toBe(false);
  });
});
