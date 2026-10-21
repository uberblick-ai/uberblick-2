import { sanitizeDeviceName } from "./device-name.js";

/** Public GitHub targets; reject path syntax before constructing any URL. */
export function isGithubUsername(value: unknown): value is string {
  return typeof value === "string" && value.length <= 39 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value);
}

export function isGithubAccountId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}

/** Optional public display data must never carry a credential or flow secret. */
export function sanitizeGithubName(value: unknown, ...secrets: (string | undefined)[]): string | undefined {
  const name = sanitizeDeviceName(value);
  return name !== undefined && !secrets.some((secret) => secret !== undefined && secret !== "" && name.includes(secret))
    ? name : undefined;
}
