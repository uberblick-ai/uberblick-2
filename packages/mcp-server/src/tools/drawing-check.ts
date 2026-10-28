import { render } from "@uberblick/ablauf";
import { parseWireframe } from "@uberblick/wireframe";
import type { Block } from "@uberblick/schema";
import type { DrawingWriteSummary } from "../outputs.js";

/** Enough lines to fix the drawing without echoing a whole invalid source. */
const MAX_DIAGNOSTICS = 20;

type Diagnostic = { line: number; severity: "error" | "warning"; message: string };

function diagnosticsOf(language: string, source: string): Diagnostic[] {
  return language === "ablauf" ? render(source).diagnostics : parseWireframe(source).diagnostics;
}

/** The drawing language of a code block the web draws, or null for ordinary code. */
export function drawingLanguage(block: Block): "ablauf" | "wireframe" | null {
  if (block.type !== "code") return null;
  return block.language === "ablauf" || block.language === "wireframe" ? block.language : null;
}

/**
 * The editor's own parse of a drawing, run after the write. Diagnostics are
 * advisory, as in the editor: they never refuse or roll back the source.
 */
export function checkDrawing(language: "ablauf" | "wireframe", source: string): DrawingWriteSummary {
  let diagnostics: Diagnostic[];
  try {
    diagnostics = diagnosticsOf(language, source);
  } catch {
    return { status: "unchecked", message: "The drawing could not be checked; the web editor shows its diagnostics." };
  }
  const status = diagnostics.some(diagnostic => diagnostic.severity === "error") ? "errors"
    : diagnostics.length > 0 ? "warnings" : "clean";
  const shown = diagnostics.slice(0, MAX_DIAGNOSTICS)
    .map(({ line, severity, message }) => ({ line, severity, message }));
  return {
    status,
    diagnostics: shown,
    ...(shown.length < diagnostics.length ? { diagnosticCount: diagnostics.length } : {}),
  };
}
