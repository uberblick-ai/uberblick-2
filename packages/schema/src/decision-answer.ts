import type * as Y from "yjs";
import { getBlocks } from "./blocks.js";
import { hasDocData } from "./data.js";
import { getMeta } from "./doc.js";
import type { BlockInput } from "./types.js";

export type DecisionAnswerShapeFailure =
  | "decision_block_unsupported"
  | "decision_answer_too_long";
export type DecisionAnswerFailure = DecisionAnswerShapeFailure
  | "decision_answer_empty"
  | "decision_tldr_unsupported"
  | "decision_data_unsupported";

/** Adjacent list items form one answer block, regardless of style or indent. */
export function decisionAnswerShapeFailure(
  blocks: readonly Pick<BlockInput, "type">[],
): DecisionAnswerShapeFailure | null {
  if (blocks.some((block) => !["paragraph", "code", "table", "list-item"].includes(block.type))) {
    return "decision_block_unsupported";
  }
  let count = 0;
  for (let index = 0; index < blocks.length; index++) {
    if (blocks[index]?.type !== "list-item" || blocks[index - 1]?.type !== "list-item") count++;
  }
  return count > 3 ? "decision_answer_too_long" : null;
}

/** Validate a proposed answer before a lifecycle writer makes any changes. */
export function decisionAnswerFailure(
  blocks: readonly BlockInput[],
  options: { tldr?: string | null; hasData?: boolean } = {},
): DecisionAnswerFailure | null {
  if (options.tldr != null) return "decision_tldr_unsupported";
  if (options.hasData === true) return "decision_data_unsupported";
  const shapeFailure = decisionAnswerShapeFailure(blocks);
  if (shapeFailure !== null) return shapeFailure;
  const hasText = blocks.some((block) => {
    const text = block.inline !== undefined && (block.type === "paragraph" || block.type === "list-item")
      ? block.inline.map((run) => run.text).join("") : (block.text ?? "");
    return text.trim() !== "";
  });
  return hasText ? null : "decision_answer_empty";
}

export function decisionDocAnswerFailure(doc: Y.Doc): DecisionAnswerFailure | null {
  return decisionAnswerFailure(getBlocks(doc), {
    tldr: getMeta(doc).tldr,
    hasData: hasDocData(doc),
  });
}

/** The first answer prose supplies the preview without its inline marks. */
export function decisionAnswerPreview(doc: Y.Doc): string | null {
  const blocks = getBlocks(doc);
  const index = blocks.findIndex((block) => block.type === "paragraph" || block.type === "list-item");
  const first = blocks[index];
  if (first === undefined) return null;
  const parts = [first.text];
  if (first.type === "list-item") {
    for (let next = index + 1; next < blocks.length; next++) {
      const block = blocks[next];
      if (block?.type !== "list-item") break;
      parts.push(block.text);
    }
  }
  const preview = parts.join("; ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(preview);
  return characters.length > 300 ? `${characters.slice(0, 299).join("")}…` : preview;
}
