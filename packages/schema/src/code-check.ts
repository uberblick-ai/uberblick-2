import { githubRepository } from "./github-reference.js";
import type { CodeCheck, CodeCheckInput } from "./types.js";

export const CODE_CHECK_RESULTS = ["matches", "ahead", "drift"] as const;

/** Full commit identities keep checks independent of a repository's current refs. */
export function normalizeCodeCheck(value: unknown): CodeCheckInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !["repository", "commit", "result"].includes(key))) return null;
  const { repository, commit, result } = candidate;
  if (typeof repository !== "string" || typeof commit !== "string") return null;
  const normalized = githubRepository(repository);
  if (normalized === null || normalized.toLowerCase() !== repository.toLowerCase()) return null;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) return null;
  if (result !== "matches" && result !== "ahead" && result !== "drift") return null;
  return { repository: normalized.toLowerCase(), commit: commit.toLowerCase(), result };
}

/** Tolerant readers omit malformed foreign entries rather than invent a check. */
export function readCodeCheck(value: unknown): CodeCheck | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const input = normalizeCodeCheck({ repository: candidate.repository, commit: candidate.commit, result: candidate.result });
  const checkedAt = candidate.checked_at;
  if (input === null || typeof checkedAt !== "string") return null;
  const timestamp = Date.parse(checkedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== checkedAt) return null;
  return { ...input, checked_at: checkedAt };
}

/** Absence remains unknown; an explicitly cached empty array is a known value. */
export function readCodeChecks(value: unknown): CodeCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const checks = new Map<string, CodeCheck>();
  for (const entry of value) {
    const check = readCodeCheck(entry);
    if (check !== null) checks.set(check.repository, check);
  }
  return [...checks.values()].sort((a, b) => a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0);
}
