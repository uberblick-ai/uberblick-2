/**
 * What a tool accepts — the other half of the contract ./failures.ts states.
 *
 * Every tool's input is one strict object: the declared fields and nothing
 * else. A raw shape handed to `registerTool` is wrapped in a *stripping*
 * object, so a key nobody declared is silently dropped and the caller is told
 * nothing — `create_doc` with a top-level `pinned: true` would create an
 * unpinned document rather than refuse an unsupported request. Refusing is the
 * honest answer to an argument this server does not understand: a misspelled
 * field is a caller mistake, and the caller is the only party who can fix it.
 * `.strict()` also advertises `additionalProperties: false` in `tools/list`, so
 * a client reads the rule before it sends anything.
 *
 * The second half is for the two tools that multiplex several actions over one
 * name — `annotate` (open a thread over a range, or reply to one) and
 * `sidebar_group` (rename, move, delete). Their fields are not independently
 * optional: `thread_id` with `start` is not a call, and a `rename` carrying an
 * `index` says one thing and means another. Publishing them as optional made
 * the handler the only place the rule existed, and it enforced the rule by
 * IGNORING the fields that did not belong — a caller mistake read as consent.
 *
 * {@link ToolMode} states each valid shape once, and {@link strictInput} makes
 * that one statement do both jobs: the rejection, before the handler runs and
 * therefore before anything durable can change, and the `oneOf` branches a
 * caller reads in `tools/list`. One table, so the advertised shape and the
 * enforced shape cannot drift apart.
 *
 * A rejection here is the MCP SDK's own plain-text validation error, not one of
 * this server's failure codes — see the boundary class ./failures.ts documents.
 * That is the point: nothing got far enough to have a code.
 */

import { z } from "zod";

/**
 * Which calls a mode claims: a discriminator field pinned to one value, or a
 * field whose mere presence chooses the shape.
 *
 * One selector per mode, and the selectors of a tool's modes must be mutually
 * exclusive and cover every input — `action` over its enum, `thread_id` over
 * present and absent. That is what lets a rejection name ONE shape ("a reply
 * does not take `block_id`") instead of listing them all, and what makes the
 * advertised `oneOf` branches match exactly one at a time.
 */
export type ModeSelector =
  | { field: string; is: string }
  | { field: string; present: boolean };

/** One valid shape of a tool that multiplexes several actions over one name. */
export interface ToolMode {
  /** How the shape names itself in a rejection and in its advertised branch. */
  title: string;
  /** Which calls are this shape. */
  when: ModeSelector;
  /** Fields this shape needs. Absent one, the call is incomplete. */
  requires?: readonly string[];
  /** Fields that belong to another shape, and are refused here. */
  forbids?: readonly string[];
}

function selects(when: ModeSelector, args: Record<string, unknown>): boolean {
  const value = args[when.field];
  return "is" in when ? value === when.is : (value !== undefined) === when.present;
}

/**
 * One mode as a JSON Schema branch, for the advertised `oneOf`.
 *
 * `properties: {field: false}` is how draft-07 forbids a key: present, it
 * validates against `false` and fails. The selector goes into the branch too,
 * so the branches stay mutually exclusive and a client can tell which one its
 * call is aiming at.
 */
function branch(mode: ToolMode): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if ("is" in mode.when) {
    properties[mode.when.field] = { const: mode.when.is };
  } else if (mode.when.present) {
    required.push(mode.when.field);
  } else {
    properties[mode.when.field] = false;
  }
  required.push(...(mode.requires ?? []));
  for (const field of mode.forbids ?? []) properties[field] = false;
  return {
    title: mode.title,
    ...(required.length === 0 ? {} : { required }),
    ...(Object.keys(properties).length === 0 ? {} : { properties }),
  };
}

/**
 * A tool's input: the declared fields, nothing else, and — where the tool has
 * modes — exactly one of them.
 *
 * The modes are checked field by field so the rejection names the field that
 * is wrong rather than the whole call. A call whose selector matches no mode is
 * left alone: the selecting field's own schema (an enum, a required string)
 * has already refused it, and a second complaint about the same key would only
 * bury the first.
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
    })
    .meta({ oneOf: modes.map(branch) });
}
