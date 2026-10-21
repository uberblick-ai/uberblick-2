/** Renderer checks for drawn code blocks, reported to writers without refusing the write. */
import { render } from "@uberblick/ablauf";
import { parseWireframe } from "@uberblick/wireframe";
import { z } from "zod";

/** Code languages the web editor draws, mapped to the package that checks them. */
const CHECKERS: Record<string, (source: string) => { line: number; severity: "error" | "warning"; message: string }[]> = {
  ablauf: (source) => render(source).diagnostics,
  wireframe: (source) => parseWireframe(source).diagnostics,
};

export const formatDiagnostic = z.object({
  block: z.string().describe("The checked block's id."),
  format: z.enum(["ablauf", "wireframe"]),
  line: z.number().int().describe("1-based line in the block text."),
  severity: z.enum(["error", "warning"]).describe("An error stops the drawing; a warning still draws."),
  message: z.string(),
}).strict();

export const formatDiagnostics = z.array(formatDiagnostic).optional().describe(
  "Problems the web renderer reports for written ablauf or wireframe blocks. The write happened; fix each problem with edit_block. Absent when the drawing is clean. See get_help ablauf or wireframe.",
);

type CheckedBlock = { id: string; type: string; text: string; language?: string };

/** Check every drawn code block; an empty answer leaves the result field out. */
export function diagnosticsFor(blocks: readonly (CheckedBlock | null)[]): { diagnostics?: z.infer<typeof formatDiagnostic>[] } {
  const found = blocks.flatMap((block) => {
    const check = block?.type === "code" && block.language !== undefined ? CHECKERS[block.language] : undefined;
    if (block === null || check === undefined) return [];
    return check(block.text).map(({ line, severity, message }) => ({
      block: block.id, format: block.language as "ablauf" | "wireframe", line, severity, message,
    }));
  });
  return found.length === 0 ? {} : { diagnostics: found };
}
