import { z } from "zod";

const historyRetentionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("named") }),
  z.strictObject({
    mode: z.literal("recent"),
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    keepNamed: z.boolean(),
  }),
  z.strictObject({ mode: z.literal("everything") }),
]);

export type HistoryRetention = z.infer<typeof historyRetentionSchema>;

export interface WorkspaceSize {
  bytes: number;
  usedFraction: number;
}

export function parseHistoryRetention(value: unknown): HistoryRetention | null {
  const parsed = historyRetentionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
