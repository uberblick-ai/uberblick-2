import { describe, expect, it } from "vitest";
import {
  DIRECTORY_SUFFIX,
  InvalidRoomError,
  InvalidWorkspaceIdError,
  SIDEBAR_SUFFIX,
  assertCanonicalRoom,
  directoryRoom,
  isCanonicalRoom,
  parseRoom,
  parseWorkspaceId,
  roomForDoc,
  sidebarRoom,
} from "../src/index.js";

const UUID = "77777777-7777-4777-8777-777777777777";
const WORKSPACE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DECORATED = `uberblick-${WORKSPACE}`;

describe("workspace ids", () => {
  it("reads a bare uuid and a slug-decorated one as the same workspace", () => {
    expect(parseWorkspaceId(WORKSPACE)).toEqual({ uuid: WORKSPACE, slug: null });
    expect(parseWorkspaceId(DECORATED)).toEqual({
      uuid: WORKSPACE,
      slug: "uberblick",
    });
    // A slug may carry hyphens of its own, and may be all digits.
    expect(parseWorkspaceId(`team-b-${WORKSPACE}`).slug).toBe("team-b");
    expect(parseWorkspaceId(`2-${WORKSPACE}`).slug).toBe("2");
  });

  it("rejects anything that is not a uuid, decorated or not", () => {
    for (const value of [
      "main",
      "",
      "-",
      WORKSPACE.toUpperCase(),
      `uberblick-${WORKSPACE.toUpperCase()}`,
      "..",
      "../etc",
      `${WORKSPACE}/evil`,
      `${WORKSPACE}x`,
      `${WORKSPACE} `,
      // The character joining a slug to the uuid is exactly one hyphen, so a
      // slug never ends in one.
      `foo--${UUID}`,
      // Not a uuid at all, only uuid-shaped punctuation.
      "7777777-7777-4777-8777-777777777777",
    ]) {
      expect(() => parseWorkspaceId(value)).toThrow(InvalidWorkspaceIdError);
    }
  });

  it("names the source but never the value it refused", () => {
    expect(() => parseWorkspaceId("s3cr3t", '"workspace" in ./uberblick.json'))
      .toThrow(/"workspace" in \.\/uberblick\.json/);
    expect(() => parseWorkspaceId("s3cr3t")).not.toThrow(/s3cr3t/);
  });
});

describe("room names", () => {
  it("builds document and directory rooms under a workspace", () => {
    expect(roomForDoc(WORKSPACE, UUID)).toBe(`${WORKSPACE}/${UUID}`);
    expect(directoryRoom(WORKSPACE)).toBe(`${WORKSPACE}/${DIRECTORY_SUFFIX}`);
    expect(SIDEBAR_SUFFIX).toBe("_sidebar");
    expect(sidebarRoom(WORKSPACE)).toBe(`${WORKSPACE}/${SIDEBAR_SUFFIX}`);
  });

  it("keeps the slug out of the room name, so both spellings name one room", () => {
    expect(roomForDoc(DECORATED, UUID)).toBe(roomForDoc(WORKSPACE, UUID));
    expect(directoryRoom(DECORATED)).toBe(directoryRoom(WORKSPACE));
  });

  it("round-trips through parseRoom", () => {
    expect(parseRoom(roomForDoc(WORKSPACE, UUID))).toEqual({
      workspaceId: WORKSPACE,
      uuid: UUID,
      isDirectory: false,
    });
    expect(parseRoom(directoryRoom(WORKSPACE))).toEqual({
      workspaceId: WORKSPACE,
      uuid: DIRECTORY_SUFFIX,
      isDirectory: true,
    });
  });

  it("refuses to read a decorated room name, so a document cannot fork", () => {
    // Built leniently, read strictly: `<slug>-<uuid>/<doc>` and
    // `<uuid>/<doc>` must never both be room names, or the hub would hold one
    // document as two.
    expect(() => parseRoom(`${DECORATED}/${UUID}`)).toThrow(InvalidRoomError);
  });

  it("rejects a name that carries no workspace", () => {
    // No default workspace to read a bare name into: it is not a room name.
    expect(() => parseRoom(UUID)).toThrow(InvalidRoomError);
    expect(() => parseRoom("_directory")).toThrow(InvalidRoomError);
  });

  it("rejects empty, over-segmented and non-workspace names", () => {
    expect(() => parseRoom("")).toThrow(InvalidRoomError);
    expect(() => parseRoom("/")).toThrow(InvalidWorkspaceIdError);
    expect(() => parseRoom(`${WORKSPACE}/${UUID}/extra`)).toThrow(InvalidRoomError);
    expect(() => parseRoom(`/${UUID}`)).toThrow(InvalidWorkspaceIdError);
    expect(() => parseRoom(`${WORKSPACE}/`)).toThrow(InvalidRoomError);
    expect(() => parseRoom(`main/${UUID}`)).toThrow(InvalidWorkspaceIdError);
    expect(() => roomForDoc("", UUID)).toThrow(InvalidWorkspaceIdError);
    expect(() => roomForDoc("main", UUID)).toThrow(InvalidWorkspaceIdError);
    expect(() => roomForDoc("a/b", UUID)).toThrow(InvalidWorkspaceIdError);
    expect(() => roomForDoc(WORKSPACE, "")).toThrow(InvalidRoomError);
    expect(() => roomForDoc(WORKSPACE, "a/b")).toThrow(InvalidRoomError);
  });
});

/**
 * The closed grammar, which lives *beside* `parseRoom` rather than inside it.
 *
 * The hub parses a room name on every authentication, so a `parseRoom` that
 * began refusing a non-canonical document segment would be the enforcement
 * change itself — landing with no flag, on whatever deploy picked it up, with
 * no operator present. These tests hold the two halves apart.
 */
describe("the canonical room grammar", () => {
  // Hex letters, so upper-casing it actually changes the string.
  const DOC = "abcdef01-2345-4678-89ab-cdef01234567";

  it("leaves parseRoom structural: a non-canonical document segment still parses", () => {
    // The one test that must exist: proof this step did not smuggle in the
    // enforcement change.
    expect(parseRoom(`${WORKSPACE}/notauuid`)).toEqual({
      workspaceId: WORKSPACE,
      uuid: "notauuid",
      isDirectory: false,
    });
    // And the validator is the thing that refuses it.
    expect(isCanonicalRoom(`${WORKSPACE}/notauuid`)).toBe(false);
  });

  it("accepts a document uuid and every reserved name", () => {
    const accepted: [label: string, room: string][] = [
      ["a document uuid", `${WORKSPACE}/${DOC}`],
      ["the directory", `${WORKSPACE}/${DIRECTORY_SUFFIX}`],
      ["the sidebar", `${WORKSPACE}/${SIDEBAR_SUFFIX}`],
      // Reserved, and deliberately not built: nothing creates a `_settings`
      // document (#177). It is in the grammar so that building it later is not
      // a change to the grammar the hub authenticates against.
      ["the reserved settings slot", `${WORKSPACE}/_settings`],
    ];
    for (const [label, room] of accepted) {
      expect(isCanonicalRoom(room), label).toBe(true);
      expect(() => assertCanonicalRoom(room), label).not.toThrow();
    }
  });

  it("rejects anything else the structural parse would have let through", () => {
    const rejected: [label: string, room: string][] = [
      ["an arbitrary word", `${WORKSPACE}/notauuid`],
      ["a reserved-looking name nobody reserved", `${WORKSPACE}/_admin`],
      [
        "the retired feedback room",
        `${WORKSPACE}/${["_feed", "back"].join("")}`,
      ],
      ["a path with an extra segment", `${WORKSPACE}/${DOC}/extra`],
      ["an empty document segment", `${WORKSPACE}/`],
      // One case rule for both segments (#196): the workspace segment has
      // always been lowercase-only, and room names are case-sensitive keys, so
      // a shouted uuid would be a second room holding one document.
      ["an upper-cased document uuid", `${WORKSPACE}/${DOC.toUpperCase()}`],
      ["a name that carries no workspace", DOC],
      ["a decorated workspace segment", `${DECORATED}/${DOC}`],
      ["a workspace segment that is not a workspace id", `main/${DOC}`],
    ];
    for (const [label, room] of rejected) {
      expect(isCanonicalRoom(room), label).toBe(false);
      expect(() => assertCanonicalRoom(room), label).toThrow();
    }
  });

  it("names the offending document segment when it refuses one", () => {
    expect(() => assertCanonicalRoom(`${WORKSPACE}/notauuid`)).toThrow(
      InvalidRoomError,
    );
    expect(() => assertCanonicalRoom(`${WORKSPACE}/notauuid`)).toThrow(
      /"notauuid"/,
    );
  });
});
