import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  WORKSPACE_SETTINGS_KEY,
  createTagCatalogEntry,
  getWorkspaceName,
  listTagCatalog,
  setWorkspaceName,
  validateWorkspaceName,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

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
