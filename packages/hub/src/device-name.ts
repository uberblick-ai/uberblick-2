/** Optional display metadata, never a device identity or credential field. */
const NON_DISPLAY_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Keep acceptable text unchanged; bad metadata must never prevent sign-in. */
export function sanitizeDeviceName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 &&
    [...value].length <= 253 && !NON_DISPLAY_TEXT.test(value)
    ? value : undefined;
}
