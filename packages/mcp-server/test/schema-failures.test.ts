import {
  AnnotationCellError,
  AnnotationRangeError,
  BlockNotFoundError,
  ConflictingLinkMarksError,
  DataError,
  InlineLinkRangeError,
  InvalidCardError,
  InvalidDocumentLifecycleError,
  InvalidFigmaError,
  InvalidListAttributesError,
  InvalidTableError,
  InvalidTableMappingError,
  InvalidTagAssignmentError,
  OldTextMismatchError,
  StaleBlockError,
  TableMappingRequiredError,
} from "@uberblick/schema";
import { describe, expect, it } from "vitest";
import {
  CardAnnotationError,
  FigmaAnnotationError,
  InvalidDocLinkTargetError,
  InvalidLinkHrefError,
  InvalidRoomError,
  InvalidSupersedesReferenceError,
  InvalidTagIdentityError,
  InvalidTagNameError,
  InvalidWorkspaceIdError,
} from "../../schema/src/errors.js";
import { INTERNAL_ERROR_MESSAGE, toFailure } from "../src/failures.js";
import type { FailedTool } from "../src/failures.js";
import { withLoggingDisabled } from "../src/log.js";

const write: FailedTool = { name: "edit_block", writes: "document" };
const read: FailedTool = { name: "get_doc", writes: null };
const current = { blockId: "block-1", currentText: "current text", currentRev: "current-rev" };

interface FailureCase {
  name: string;
  error: Error;
  tool?: FailedTool;
}

const mapped: FailureCase[] = [
  { name: "block not found", error: new BlockNotFoundError("block-1") },
  { name: "block not found while reading", error: new BlockNotFoundError("block-1"), tool: read },
  { name: "block not found while inserting", error: new BlockNotFoundError("block-1"), tool: { name: "insert_block", writes: "document" } },
  { name: "invalid list attributes", error: new InvalidListAttributesError("unsupported list") },
  { name: "invalid table", error: new InvalidTableError() },
  { name: "invalid card default", error: new InvalidCardError() },
  { name: "invalid card reason", error: new InvalidCardError("unknown header") },
  { name: "invalid Figma default", error: new InvalidFigmaError() },
  { name: "invalid Figma reason", error: new InvalidFigmaError("unsupported provider") },
  { name: "table mapping required", error: new TableMappingRequiredError() },
  { name: "invalid table mapping", error: new InvalidTableMappingError("duplicate row") },
  { name: "annotation cell missing", error: new AnnotationCellError("missing", "block-1") },
  { name: "annotation cell wrong block", error: new AnnotationCellError("not-table", "block-1") },
  { name: "annotation cell outside table", error: new AnnotationCellError("out-of-bounds", "block-1") },
  { name: "stale block text and rev", error: new StaleBlockError({ ...current, expectedText: "old text", expectedRev: "old-rev" }) },
  { name: "stale block text only", error: new StaleBlockError({ ...current, expectedText: "old text" }) },
  { name: "stale block rev only", error: new StaleBlockError({ ...current, expectedRev: "old-rev" }) },
  { name: "stale block no assertions", error: new StaleBlockError(current) },
  { name: "stale block empty assertions", error: new StaleBlockError({ ...current, expectedText: "", expectedRev: "" }) },
  { name: "old text mismatch", error: new OldTextMismatchError({ ...current, expectedText: "wrong text", expectedRev: "current-rev" }) },
  { name: "inline link empty range", error: new InlineLinkRangeError("empty", "block-1") },
  { name: "inline link wrong block", error: new InlineLinkRangeError("not-prose", "block-1", "table") },
  { name: "inline link unknown block type", error: new InlineLinkRangeError("not-prose", "block-1") },
  { name: "conflicting link marks", error: new ConflictingLinkMarksError("https://example.com", "doc-1") },
  { name: "annotation empty range", error: new AnnotationRangeError("empty", "block-1") },
  { name: "annotation overlapping thread", error: new AnnotationRangeError("overlap", "block-1", "thread-1") },
  { name: "annotation unknown conflicting thread", error: new AnnotationRangeError("overlap", "block-1") },
  { name: "invalid document lifecycle", error: new InvalidDocumentLifecycleError("decision", "planned") },
  { name: "invalid lifecycle null values", error: new InvalidDocumentLifecycleError(null, null) },
  { name: "invalid lifecycle missing values", error: new InvalidDocumentLifecycleError(undefined, undefined) },
  { name: "tag assignment on metadata", error: new InvalidTagAssignmentError(["missing"], ["retired"]), tool: { name: "set_metadata", writes: "document" } },
  { name: "tag assignment on create", error: new InvalidTagAssignmentError(["missing"], ["retired"]), tool: { name: "create_doc", writes: "document" } },
  { name: "tag assignment unknown only", error: new InvalidTagAssignmentError(["missing"], []) },
  { name: "tag assignment retired only", error: new InvalidTagAssignmentError([], ["retired"]) },
  { name: "data error", error: new DataError("data_record_invalid", "Record /count: expected type number", { collection: "observations", recordId: "row-1", path: "/count" }) },
];

const unmapped: FailureCase[] = [
  { name: "card annotation", error: new CardAnnotationError("block-1") },
  { name: "Figma annotation", error: new FigmaAnnotationError("block-1") },
  { name: "invalid link href", error: new InvalidLinkHrefError("file:///private") },
  { name: "invalid document link target", error: new InvalidDocLinkTargetError("not-a-uuid") },
  { name: "invalid tag name", error: new InvalidTagNameError("Invalid tag") },
  { name: "invalid tag identity", error: new InvalidTagIdentityError("unknown", "tag-1") },
  { name: "invalid supersedes reference", error: new InvalidSupersedesReferenceError("self-reference", "doc-1") },
  { name: "invalid room", error: new InvalidRoomError("private-room", "missing workspace") },
  { name: "invalid workspace id", error: new InvalidWorkspaceIdError("workspace argument") },
];

describe("schema failure wire compatibility", () => {
  it.each(mapped)("preserves serialized $name", ({ error, tool = write }) => {
    const failure = toFailure(tool, error);
    expect(error.name).toBe(error.constructor.name);
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure.payload, null, 2)).toMatchSnapshot();
  });

  it.each(unmapped)("keeps $name internal", ({ error }) => {
    const failure = withLoggingDisabled(() => toFailure(write, error));
    expect(error.name).toBe(error.constructor.name);
    expect(failure.payload).toEqual({ error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
    expect(JSON.stringify(failure.payload, null, 2)).toMatchSnapshot();
  });

  it("retains the typed errors consumed by web and schema callers", () => {
    const table: unknown = new InvalidTableError();
    const annotation: unknown = new AnnotationRangeError("overlap", "block-1", "thread-1");
    expect(table).toBeInstanceOf(InvalidTableError);
    expect(annotation).toBeInstanceOf(AnnotationRangeError);
    if (!(annotation instanceof AnnotationRangeError)) throw new Error("annotation error lost its class");
    expect(annotation.reason).toBe("overlap");
    expect(annotation.conflictingThreadId).toBe("thread-1");

    const stale = new StaleBlockError(current);
    expect(stale.expectedText).toBeUndefined();
    expect(stale.expectedRev).toBeUndefined();
  });

  it("keeps tag assignment details independent of the caller's arrays", () => {
    const unknown = ["missing"];
    const retired = ["retired"];
    const error = new InvalidTagAssignmentError(unknown, retired);
    unknown.push("later-unknown");
    retired.push("later-retired");
    expect(error.unknown).toEqual(["missing"]);
    expect(error.retired).toEqual(["retired"]);
    expect(toFailure(write, error).payload).toMatchObject({ unknown: ["missing"], retired: ["retired"] });
  });
});
