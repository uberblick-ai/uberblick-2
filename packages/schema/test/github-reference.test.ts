import { describe, expect, it } from "vitest";
import { githubItemUrl, githubReference, githubRepository } from "../src/index.js";

describe("GitHub repository addresses", () => {
  it("normalizes repository references, web addresses and SSH origins", () => {
    for (const input of [
      " Owner/My_Repo ", "Owner/My_Repo.git", "Owner/My_Repo/",
      "https://github.com/Owner/My_Repo", "https://github.com/Owner/My_Repo.git/",
      "http://GITHUB.COM/Owner/My_Repo/", "git@github.com:Owner/My_Repo.git",
      "ssh://git@github.com/Owner/My_Repo.git",
    ]) expect(githubRepository(input), input).toBe("Owner/My_Repo");
  });

  it("refuses foreign hosts, item paths, credentials and malformed repositories", () => {
    for (const input of [
      "", "repo", "owner/repo/extra", "owner/.", "owner/..", "owner/.git",
      "ow_ner/repo", "owner/re po", "owner/repo#1", "owner/repo?query=1",
      "https://github.example.com/owner/repo", "https://github.com:444/owner/repo",
      "https://user@github.com/owner/repo", "https://github.com/owner/repo/issues/1",
      "https://github.com/owner/repo.git?query=1", "https://github.com/owner/repo#section",
      "https://github.com/owner/old/../repo", "https://github.com/owner/%2e/repo",
      "https://github.com/owner/%72epo", "https://github.com/owner/re\npo",
      "git@github.example.com:owner/repo.git", "ssh://git:secret@github.com/owner/repo",
      "ssh://git@github.com:22/owner/repo", "ftp://github.com/owner/repo",
    ]) expect(githubRepository(input), input).toBeNull();
  });
});

describe("GitHub item references", () => {
  it("reads issue and pull request kinds while preserving repository spelling", () => {
    expect(githubItemUrl("https://github.com/Owner/Repo/issues/42")).toEqual({
      owner: "Owner", repo: "Repo", number: "42", numberText: "42", kind: "issue",
    });
    expect(githubItemUrl("http://GITHUB.COM/OWNER/My_Repo/pull/00042/files?view=split#diff-1")).toEqual({
      owner: "OWNER", repo: "My_Repo", number: "42", numberText: "00042", kind: "pull-request",
    });
  });

  it("keeps exact decimal identities and the existing case, deep-link and HTTP spellings", () => {
    for (const input of [
      " OWNER/Repo#00042 ",
      "https://github.com/Owner/Repo/issues/42",
      "http://GITHUB.COM/owner/repo/PULL/00042/files",
      "https://github.com/OWNER/REPO/issues/42/comments?sort=oldest#issuecomment-1",
      "https://github.com/owner/repo/pull/42?view=split#discussion_r1",
    ]) {
      expect(githubReference(input), input).toBe("owner/repo#42");
    }
    const number = "9007199254740993123456789";
    expect(githubReference(`Owner/Repo#000${number}`)).toBe(`owner/repo#${number}`);
    expect(githubItemUrl(`https://github.com/Owner/Repo/issues/${number}`)?.number).toBe(number);
  });

  it("refuses non-item addresses, foreign hosts, credentials and malformed references", () => {
    for (const input of [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/issues",
      "https://github.com/owner/repo/commit/42",
      "https://github.com/owner/repo/discussions/42",
      "https://github.com/owner/repo/blob/main/file.ts",
      "https://github.example.com/owner/repo/issues/42",
      "https://example.com/owner/repo/issues/42",
      "https://github.com:444/owner/repo/issues/42",
      "https://user:password@github.com/owner/repo/issues/42",
      "https://github.com/owner/repo/issues/42oops",
      "https://github.com/owner/repo/issues/0",
      "https://github.com/owner/repo/issues/000",
      "https://github.com/owner/repo/issues/-42",
      "ftp://github.com/owner/repo/issues/42",
      "owner/repo#0",
      "owner/.#42",
      "owner/..#42",
      "owner/repo#42 owner/repo#43",
      "#42",
      "repo#42",
      "not a reference",
    ]) {
      expect(githubItemUrl(input), input).toBeNull();
      expect(githubReference(input), input).toBeNull();
    }
    expect(githubItemUrl("owner/repo#42")).toBeNull();
  });
});
