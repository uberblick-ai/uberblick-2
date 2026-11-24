import { githubRepository } from "./github-reference.js";

/** Blank values clear scope; names remain free text rather than a role registry. */
export function normalizeMemoryAgent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.trim() === "") return "";
  return value.trim() === value && !/\p{Uppercase}|\p{Lt}/u.test(value) ? value : null;
}

/** Accept exactly the owner/name form used by code checks. */
export function normalizeMemoryRepository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.trim() === "") return "";
  const repository = githubRepository(value);
  return repository !== null && repository.toLowerCase() === value.toLowerCase()
    ? repository.toLowerCase() : null;
}

/** Foreign or mismatched scope never leaks into another document kind. */
export function readMemoryFields(kind: unknown, agent: unknown, repository: unknown): {
  agent?: string;
  repository?: string;
} {
  if (kind !== "memory") return {};
  const name = normalizeMemoryAgent(agent);
  const repo = normalizeMemoryRepository(repository);
  return {
    ...(name ? { agent: name } : {}),
    ...(repo ? { repository: repo } : {}),
  };
}
