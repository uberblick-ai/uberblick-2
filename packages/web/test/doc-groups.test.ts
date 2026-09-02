/**
 * The document's group, derived from its tags (#39's rule).
 *
 * What is left of the tag grouping now that the sidebar is the `_sidebar`
 * document (#115): the identity line's badge still names a neighbourhood, and
 * names it from the document's own `meta.tags`. Two
 * properties are worth pinning — canonical order is the tie-break for a
 * document carrying several known tags, and everything else lands in one
 * trailing group — because both are what make two replicas name the same group
 * without agreeing on anything first.
 */

import { describe, expect, it } from "vitest";
import { groupKeyForTags, groupLabel } from "../src/ui/groups.js";

describe("a document's group derives from its tags", () => {
  it("names the first known tag in canonical order, not the document's own", () => {
    expect(groupKeyForTags(["reference", "feature"])).toBe("feature");
    expect(groupLabel(groupKeyForTags(["reference", "feature"]))).toBe("Features");
  });

  it("drops an untagged or unknown-tagged doc into the trailing group", () => {
    expect(groupKeyForTags([])).toBe("other");
    expect(groupKeyForTags(["misc", "wip"])).toBe("other");
    // And that group has no name to show (#535): the fallback says nothing
    // about a document, so the surfaces that render a group render nothing.
    expect(groupLabel(groupKeyForTags([]))).toBeNull();
  });
});
