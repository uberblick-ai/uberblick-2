import { InvalidFigmaError } from "../errors.js";

export interface FigmaFields {
  kind: "frame" | "file" | "prototype" | "board" | "slides" | "community file";
  file: string;
  fileName?: string;
  node?: string;
}

export const FIGMA_PROVIDER = {
  hosts: ["www.figma.com", "figma.com"],
  paths: ["design", "file", "proto", "board", "slides", "community/file"],
  parameters: ["node-id", "starting-point-node-id", "version-id"],
  normalizeLink: normalizeFigmaLink,
} as const;

const HOST_MESSAGE = "figma blocks take figma.com links only; use a plain link for other sites";
const PATH_MESSAGE = "Figma links must use /design/, /file/, /proto/, /board/, /slides/ or /community/file/, followed by a file key and optional file name";

/** Keep only the provider's view identity, without contacting the provider. */
export function normalizeFigmaLink(source: string): { url: string; figma: FigmaFields } {
  let input: URL;
  try {
    input = new URL(source);
  } catch {
    throw new InvalidFigmaError(HOST_MESSAGE);
  }
  if (input.protocol !== "https:" || !(FIGMA_PROVIDER.hosts as readonly string[]).includes(input.hostname) ||
    input.username !== "" || input.password !== "" || input.port !== "" || source.includes("\\") ||
    Array.from(source).some((character) => character.charCodeAt(0) < 32)) {
    throw new InvalidFigmaError(HOST_MESSAGE);
  }
  // URL normalizes dot segments; reject those rather than accepting extra paths.
  const rawPath = /^https:\/\/[^/]+([^?#]*)/i.exec(source)?.[1] ?? "";
  if (rawPath.split("/").some((part) => /^(?:\.|%2e){1,2}$/i.test(part))) throw new InvalidFigmaError(PATH_MESSAGE);
  const match = /^\/(design|file|proto|board|slides)\/([^/]+)(?:\/([^/]+))?$/.exec(input.pathname);
  const community = /^\/community\/file\/([^/]+)(?:\/([^/]+))?$/.exec(input.pathname);
  if (match === null && community === null) throw new InvalidFigmaError(PATH_MESSAGE);
  const path = match?.[1] ?? "community/file";
  const file = match?.[2] ?? community?.[1] ?? "";
  const name = match?.[3] ?? community?.[2];
  let decodedFile: string;
  let fileName: string | undefined;
  try {
    decodedFile = decodeURIComponent(file);
    fileName = name === undefined ? undefined : decodeURIComponent(name).replace(/-/g, " ");
  } catch {
    throw new InvalidFigmaError(PATH_MESSAGE);
  }
  const output = new URL(`https://www.figma.com/${path}/${file}${name === undefined ? "" : `/${name}`}`);
  for (const parameter of FIGMA_PROVIDER.parameters) {
    const value = input.searchParams.get(parameter);
    if (value !== null) output.searchParams.set(parameter, value);
  }
  const node = input.searchParams.get("node-id");
  const kind: FigmaFields["kind"] = path === "design" || path === "file"
    ? node === null ? "file" : "frame"
    : path === "proto" ? "prototype"
      : path === "board" ? "board"
        : path === "slides" ? "slides" : "community file";
  return {
    url: output.href,
    figma: {
      kind, file: decodedFile,
      ...(fileName === undefined ? {} : { fileName }),
      ...(node === null ? {} : { node: node.replace(/-/g, ":") }),
    },
  };
}
