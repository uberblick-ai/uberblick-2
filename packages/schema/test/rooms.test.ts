import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE,
  DIRECTORY_ROOM,
  DIRECTORY_SUFFIX,
  InvalidRoomError,
  directoryRoom,
  parseRoom,
  roomForDoc,
} from "../src/index.js";

const UUID = "77777777-7777-4777-8777-777777777777";

describe("room names", () => {
  it("builds document and directory rooms under a workspace", () => {
    expect(DEFAULT_WORKSPACE).toBe("main");
    expect(roomForDoc("main", UUID)).toBe(`main/${UUID}`);
    expect(roomForDoc("acme", UUID)).toBe(`acme/${UUID}`);
    expect(directoryRoom("acme")).toBe("acme/_directory");
    expect(directoryRoom()).toBe("main/_directory");
  });

  it("keeps the bare directory constant as the document-id suffix", () => {
    expect(DIRECTORY_SUFFIX).toBe("_directory");
    // Deprecated, kept for pre-tenancy callers.
    expect(DIRECTORY_ROOM).toBe(DIRECTORY_SUFFIX);
    expect(directoryRoom("main").endsWith(DIRECTORY_SUFFIX)).toBe(true);
  });

  it("round-trips through parseRoom, reading a bare room as the default workspace", () => {
    expect(parseRoom(roomForDoc("acme", UUID))).toEqual({
      workspaceId: "acme",
      uuid: UUID,
      isDirectory: false,
    });
    expect(parseRoom(directoryRoom("acme"))).toEqual({
      workspaceId: "acme",
      uuid: DIRECTORY_SUFFIX,
      isDirectory: true,
    });

    // A pre-tenancy room name has no workspace segment: it belongs to the
    // default workspace, so old rooms keep resolving.
    expect(parseRoom(UUID)).toEqual({
      workspaceId: DEFAULT_WORKSPACE,
      uuid: UUID,
      isDirectory: false,
    });
    expect(parseRoom("_directory")).toEqual({
      workspaceId: DEFAULT_WORKSPACE,
      uuid: DIRECTORY_SUFFIX,
      isDirectory: true,
    });
  });

  it("rejects empty and over-segmented names", () => {
    expect(() => parseRoom("")).toThrow(InvalidRoomError);
    expect(() => parseRoom("/")).toThrow(InvalidRoomError);
    expect(() => parseRoom(`main/${UUID}/extra`)).toThrow(InvalidRoomError);
    expect(() => parseRoom(`/${UUID}`)).toThrow(InvalidRoomError);
    expect(() => parseRoom("main/")).toThrow(InvalidRoomError);
    expect(() => roomForDoc("", UUID)).toThrow(InvalidRoomError);
    expect(() => roomForDoc("main", "")).toThrow(InvalidRoomError);
    expect(() => roomForDoc("a/b", UUID)).toThrow(InvalidRoomError);
    expect(() => roomForDoc("main", "a/b")).toThrow(InvalidRoomError);
  });
});
