// Types for providers.js so the spike node view in packages/web can import it.
export interface EmbedProvider {
  id: string;
  label: string;
  frameSrc: string[];
  sandbox: string;
  allow: string;
  referrerPolicy: string;
  shape: { height?: number; aspect?: number };
}
export interface ResolvedEmbed {
  provider: EmbedProvider;
  kind: string;
  title: string;
  candidates: string[];
}
export const PROVIDERS: EmbedProvider[];
export function resolveEmbed(raw: string, opts?: { theme?: "light" | "dark" }): ResolvedEmbed | null;
export function frameSrc(): string;
