/** The shell's upstream reading, shared by the header and General settings. */
export function workspaceLocationLabel(address: string | null): string | null {
  if (address === "local") return "This device";
  if (address === null) return null;
  try {
    const url = new URL(address);
    return url.protocol === "ws:" || url.protocol === "wss:" ? url.host || null : null;
  } catch {
    return null;
  }
}
