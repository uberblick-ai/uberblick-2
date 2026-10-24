/**
 * Pass strict objects to registerTool: raw shapes silently strip unknown keys.
 * ToolMode drives validation only. Advertised schemas stay flat: some clients
 * drop the root properties of a schema with a root oneOf or anyOf. SDK
 * validation refuses before handlers run and returns its own plain-text error.
 */

import { z } from "zod";

/**
 * Select by a field's value or presence. Modes must be mutually exclusive and
 * cover every valid input so validation selects one shape.
 */
export type ModeSelector =
  | { field: string; is: string }
  | { field: string; present: boolean }
  | { all: readonly ModeSelector[] };

/** One valid shape of a tool that multiplexes several actions over one name. */
export interface ToolMode {
  /** How the shape names itself in a rejection. */
  title: string;
  /** Which calls are this shape. */
  when: ModeSelector;
  /** Fields this shape needs. Absent one, the call is incomplete. */
  requires?: readonly string[];
  /** Fields that belong to another shape, and are refused here. */
  forbids?: readonly string[];
}

function selects(when: ModeSelector, args: Record<string, unknown>): boolean {
  if ("all" in when) return when.all.every((selector) => selects(selector, args));
  const value = args[when.field];
  return "is" in when ? value === when.is : (value !== undefined) === when.present;
}

/**
 * Report mode errors per field. An unmatched selector is already refused by
 * its own schema, so do not add a duplicate complaint.
 */
export function strictInput<Shape extends z.ZodRawShape>(
  shape: Shape,
  modes: readonly ToolMode[] = [],
): z.ZodObject<Shape, z.core.$strict> {
  const object = z.object(shape).strict();
  if (modes.length === 0) return object;
  return object
    .superRefine((value, ctx) => {
      const args = value as Record<string, unknown>;
      const mode = modes.find((candidate) => selects(candidate.when, args));
      if (mode === undefined) return;
      for (const field of mode.requires ?? []) {
        if (args[field] === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${mode.title} needs \`${field}\``,
            path: [field],
          });
        }
      }
      for (const field of mode.forbids ?? []) {
        if (args[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${mode.title} does not take \`${field}\``,
            path: [field],
          });
        }
      }
    });
}
