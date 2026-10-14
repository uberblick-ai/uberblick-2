import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  WORKSPACE_SETTINGS_KEY,
  createTagCatalogEntry,
  getWorkspaceMainRepository,
  getWorkspaceName,
  listTagCatalog,
  setWorkspaceName,
  setWorkspaceMainRepository,
  validateWorkspaceName,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

describe("shared workspace main repository", () => {
  it("reads unset without updates and persists one normalized setting beside name and tags", () => {
    const settings = new Y.Doc();
    setWorkspaceName(settings, "Product");
    createTagCatalogEntry(settings, "product", "11111111-1111-4111-8111-111111111111");
    const tags = listTagCatalog(settings);
    const before = Y.encodeStateAsUpdate(settings);
    expect(getWorkspaceMainRepository(settings)).toBeNull();
    expect(Y.encodeStateAsUpdate(settings)).toEqual(before);
    expect(setWorkspaceMainRepository(settings, "https://github.com/Owner/Repo.git/")).toBe("Owner/Repo");
    expect(settings.getMap(WORKSPACE_SETTINGS_KEY).toJSON()).toEqual({ name: "Product", mainRepository: "Owner/Repo" });
    expect(listTagCatalog(settings)).toEqual(tags);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(settings));
    expect(getWorkspaceMainRepository(restored)).toBe("Owner/Repo");
    setWorkspaceMainRepository(settings, "Other/Repo");
    expect(getWorkspaceMainRepository(settings)).toBe("Other/Repo");
    expect(setWorkspaceMainRepository(settings, "  ")).toBeNull();
    expect(settings.getMap(WORKSPACE_SETTINGS_KEY).toJSON()).toEqual({ name: "Product" });
  });

  it("invalid writes change nothing and unreadable stored values read as unset", () => {
    const settings = new Y.Doc();
    setWorkspaceMainRepository(settings, "Owner/Repo");
    const before = Y.encodeStateAsUpdate(settings);
    for (const input of ["repo", "owner/repo/issues/1", "https://example.com/owner/repo"]) {
      expect(() => setWorkspaceMainRepository(settings, input)).toThrow(/Main repository/);
    }
    expect(Y.encodeStateAsUpdate(settings)).toEqual(before);
    for (const value of [false, 42, {}, "", "invalid", "https://example.com/owner/repo"]) {
      settings.getMap<unknown>(WORKSPACE_SETTINGS_KEY).set("mainRepository", value);
      const unreadable = Y.encodeStateAsUpdate(settings);
      expect(getWorkspaceMainRepository(settings)).toBeNull();
      expect(Y.encodeStateAsUpdate(settings)).toEqual(unreadable);
    }
    const foreign = new Y.Doc();
    foreign.getText(WORKSPACE_SETTINGS_KEY).insert(0, "unreadable root");
    const foreignState = Y.encodeStateAsUpdate(foreign);
    expect(getWorkspaceMainRepository(foreign)).toBeNull();
    expect(Y.encodeStateAsUpdate(foreign)).toEqual(foreignState);
  });

  it("concurrent fills converge to one whole identity in either delivery order", () => {
    const [left, right] = replicaPair(() => {});
    setWorkspaceMainRepository(left, "Owner/First");
    setWorkspaceMainRepository(right, "Owner/Second");
    const leftUpdate = Y.encodeStateAsUpdate(left);
    const rightUpdate = Y.encodeStateAsUpdate(right);
    const observers = [new Y.Doc(), new Y.Doc()];
    Y.applyUpdate(observers[0]!, leftUpdate);
    Y.applyUpdate(observers[0]!, rightUpdate);
    Y.applyUpdate(observers[1]!, rightUpdate);
    Y.applyUpdate(observers[1]!, leftUpdate);
    syncDocs(left, right);
    const winner = getWorkspaceMainRepository(left);
    expect(["Owner/First", "Owner/Second"]).toContain(winner);
    expect(getWorkspaceMainRepository(right)).toBe(winner);
    for (const observer of observers) expect(getWorkspaceMainRepository(observer)).toBe(winner);
  });
});

describe("shared workspace name", () => {
  it("starts unnamed and writes only one name beside the unchanged tag catalog", () => {
    const settings = new Y.Doc();
    createTagCatalogEntry(settings, "product", "11111111-1111-4111-8111-111111111111");
    const tags = listTagCatalog(settings);
    const before = Y.encodeStateAsUpdate(settings);
    expect(getWorkspaceName(settings)).toBeNull();
    expect(Y.encodeStateAsUpdate(settings)).toEqual(before);

    expect(setWorkspaceName(settings, "  Product Research  ")).toBe("Product Research");
    expect(getWorkspaceName(settings)).toBe("Product Research");
    expect(settings.getMap(WORKSPACE_SETTINGS_KEY).toJSON()).toEqual({ name: "Product Research" });
    expect(listTagCatalog(settings)).toEqual(tags);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(settings));
    expect(getWorkspaceName(restored)).toBe("Product Research");
  });

  it("refuses invalid input before changing state", () => {
    const settings = new Y.Doc();
    setWorkspaceName(settings, "Original");
    const before = Y.encodeStateAsUpdate(settings);
    for (const input of ["", "   ", "a".repeat(65), "a\nb", "a\u0000b", "a\u200Db"]) {
      expect(() => setWorkspaceName(settings, input), JSON.stringify(input)).toThrow(/1–64.*control or format/);
    }
    expect(Y.encodeStateAsUpdate(settings)).toEqual(before);
    expect(getWorkspaceName(settings)).toBe("Original");
  });

  it("accepts the same Unicode length rule as a display name", () => {
    expect(validateWorkspaceName("  研究  ")).toBe("研究");
    expect(validateWorkspaceName("😀".repeat(64))).toBe("😀".repeat(64));
    expect(() => validateWorkspaceName("😀".repeat(65))).toThrow();
  });

  it("converges concurrent renames to one submitted whole name in either delivery order", () => {
    const [left, right] = replicaPair((doc) => setWorkspaceName(doc, "Original"));
    const first = "Product Research";
    const second = "Customer Studies";
    setWorkspaceName(left, first);
    setWorkspaceName(right, second);

    const leftUpdate = Y.encodeStateAsUpdate(left);
    const rightUpdate = Y.encodeStateAsUpdate(right);
    const observers = [new Y.Doc(), new Y.Doc()];
    Y.applyUpdate(observers[0]!, leftUpdate);
    Y.applyUpdate(observers[0]!, rightUpdate);
    Y.applyUpdate(observers[1]!, rightUpdate);
    Y.applyUpdate(observers[1]!, leftUpdate);
    syncDocs(left, right);

    const winner = getWorkspaceName(left);
    expect([first, second]).toContain(winner);
    expect(getWorkspaceName(right)).toBe(winner);
    for (const observer of observers) expect(getWorkspaceName(observer)).toBe(winner);
  });
});
