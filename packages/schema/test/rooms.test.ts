import { describe, expect, it } from "vitest";
import {
  DIRECTORY_SUFFIX,
  FEEDBACK_SUFFIX,
  InvalidRoomError,
  InvalidWorkspaceIdError,
  SIDEBAR_SUFFIX,
  directoryRoom,
  feedbackRoom,
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
    expect(FEEDBACK_SUFFIX).toBe("_feedback");
    expect(feedbackRoom(WORKSPACE)).toBe(`${WORKSPACE}/${FEEDBACK_SUFFIX}`);
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
