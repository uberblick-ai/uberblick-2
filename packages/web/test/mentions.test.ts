import { describe, expect, it } from "vitest";
import { mentionCandidates, personMentionTokens } from "../src/mentions.js";

describe("shared mention candidates", () => {
  const docs = [
    { docId: "current", label: "Ali's notes" },
    { docId: "target", label: "Áli's archive" },
    { docId: "other", label: "Other" },
  ];

  it("puts matching members alphabetically ahead of matching document titles", () => {
    expect(mentionCandidates(docs, ["sally", "Zali", "Alice", "Malik"], "ALI", "current")).toEqual([
      { kind: "person", username: "Alice", label: "@Alice" },
      { kind: "person", username: "Malik", label: "@Malik" },
      { kind: "person", username: "Zali", label: "@Zali" },
      { kind: "document", docId: "target", label: "Áli's archive" },
    ]);
  });

  it("caps the combined list at eight and offers documents without a member list", () => {
    expect(mentionCandidates(docs, ["a", "b", "c", "d", "e", "f", "g"], "", "current")
      .map((candidate) => candidate.label)).toEqual(["@a", "@b", "@c", "@d", "@e", "@f", "@g", "Áli's archive"]);
    expect(mentionCandidates(docs, [], "ali", "current")).toEqual([
      { kind: "document", docId: "target", label: "Áli's archive" },
    ]);
  });
});

describe("person mention presentation tokens", () => {
  it("recognizes only whole current handles, preserving spelling and punctuation", () => {
    const text = "@Alice, (@bob)! user@alice.test @alice-old @alice_unknown @unknown @aliceé";
    expect(personMentionTokens(text, ["alice", "BOB"])).toEqual([
      { from: 0, to: 6, username: "alice", text: "@Alice" },
      { from: 9, to: 13, username: "BOB", text: "@bob" },
    ]);
    expect(personMentionTokens(text, [])).toEqual([]);
  });
});
