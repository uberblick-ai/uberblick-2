import { readFileSync, writeFileSync } from "node:fs";
import { openWorkspaceReplicas, readWorkspaceData, updateWorkspaceData, WorkspaceDataWriteError } from "@uberblick/mcp-server";
import { canonicalDocumentUuid, parseWorkspaceId } from "@uberblick/schema";
import type { DataCollectionChange, DocData } from "@uberblick/schema";
import { resolveMcpConfig } from "./budget.js";
import { requireBinding, resolveConfig } from "@uberblick/mcp-server/project-config";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { ensureWorkspaceBinding } from "@uberblick/mcp-server/workspace-registry";
import { type CommandArgs, usageError } from "./command.js";

export const DATA_GET_OPTIONS = { out: { type: "string" } } as const;
export const DATA_UPDATE_OPTIONS = {
  file: { type: "string" },
  "dry-run": { type: "boolean" },
} as const;

export const DATA_HELP = `usage: ub data [command]

commands:
  get <doc> [<collection>]       # Print the data summary, or one collection as JSON
  update <doc> --file <path|->   # Apply update_data operations from a file, or - for stdin

options:
  --out <file>                   # get: write the collection to this file instead of stdout
  --dry-run                      # update: validate and report, write nothing
  -h, --help                     # show this help

update is not briefed: it skips the workspace guidance reads that MCP writes require.
`;

type DataCommand =
  | { command: "get"; doc: string; collection?: string; out?: string }
  | { command: "update"; doc: string; file: string; dryRun: boolean };

export async function getDataCommand({ positionals, values }: CommandArgs<typeof DATA_GET_OPTIONS>, io: Io = processIo): Promise<number> {
  const [doc, collection] = positionals;
  if (values.out !== undefined && (values.out === "" || collection === undefined)) {
    usageError("--out needs a file and a collection");
  }
  return await dataCommand({ command: "get", doc: doc as string,
    ...(collection === undefined ? {} : { collection }), ...(values.out === undefined ? {} : { out: values.out }) }, io);
}

export async function updateDataCommand({ positionals, values }: CommandArgs<typeof DATA_UPDATE_OPTIONS>, io: Io = processIo): Promise<number> {
  if (values.file === undefined || values.file === "") usageError("expected one document and --file <path|->");
  return await dataCommand({ command: "update", doc: positionals[0] as string, file: values.file,
    dryRun: values["dry-run"] === true }, io);
}

/** URL parsing never follows a link; the bound workspace supplies all access. */
function documentUuid(value: string, workspace: string): string {
  const bare = canonicalDocumentUuid(value);
  if (bare !== null) return bare;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("expected a document UUID or document link"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") {
    throw new Error("expected an HTTP(S) document link");
  }
  const segments = url.pathname.replace(/\/$/, "").split("/").slice(1).map(decodeURIComponent);
  const history = segments.length === 4 && segments[2]?.toLowerCase() === "record" &&
    canonicalDocumentUuid(segments[1]) !== null;
  if (segments.length !== 2 && !history) throw new Error("expected a document link with workspace and document UUID");
  const linkedWorkspace = parseWorkspaceId(segments[0] ?? "", "document link workspace").uuid;
  if (linkedWorkspace !== workspace) throw new Error("document link belongs to another workspace");
  const uuid = canonicalDocumentUuid(segments[history ? 3 : 1]);
  if (uuid === null) throw new Error("document link has no document UUID");
  return uuid;
}

function number(value: number): string { return value.toLocaleString("en-US"); }
function records(value: number): string { return `${number(value)} record${value === 1 ? "" : "s"}`; }
function width(names: string[]): number { return Math.max(11, ...names.map(name => name.length + 3)); }

function renderSummary(data: DocData | null): string {
  if (data === null) return "no data\n";
  const padding = width(data.collections.map(collection => collection.name));
  const lines = data.collections.map(collection =>
    `${collection.name.padEnd(padding)}${records(collection.records.length)}  ${collection.valid ? "valid" : "invalid"}\n`,
  ).join("");
  return `${lines}${number(data.bytes)} bytes\n`;
}

function renderChanges(collections: DataCollectionChange[], dryRun: boolean): string {
  const padding = width(collections.map(collection => collection.name));
  return collections.map(collection => {
    const changes = [
      ...(collection.upserted === 0 ? [] : [`${number(collection.upserted)} upserted`]),
      ...(collection.removed === 0 ? [] : [`${number(collection.removed)} deleted`]),
      ...(collection.deleted ? ["collection deleted"] : collection.schemaChanged ? ["schema changed"] : []),
    ];
    return `${collection.name.padEnd(padding)}${dryRun ? "would be " : ""}${records(collection.recordCount)} (${changes.length === 0 ? "no change" : changes.join(", ")})\n`;
  }).join("");
}

function readOperations(file: string): unknown {
  const input = readFileSync(file === "-" ? 0 : file);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)); }
  catch { throw new Error("input must be a UTF-8 JSON array of update_data operations"); }
  return value;
}

function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = "details" in error ? error.details as Record<string, unknown> : undefined;
  const location = typeof details?.collection === "string"
    ? `${details.collection}${typeof details.recordId === "string" ? `/${details.recordId}` : ""}: ` : "";
  return `${location}${error.message}`;
}

function failureOutcome(error: unknown, saved: "synced" | "local" | "unconfirmed" | undefined): string {
  if (saved === "synced") return "saved; synced with hub\n";
  if (saved === "local" || error instanceof WorkspaceDataWriteError && error.writeOutcome === "saved-locally") {
    return "saved locally; not yet synced with hub\n";
  }
  return saved === "unconfirmed" || error instanceof WorkspaceDataWriteError
    ? "write outcome unconfirmed; read the data before retrying\n" : "nothing written\n";
}

async function dataCommand(command: DataCommand, io: Io): Promise<number> {
  let saved: "synced" | "local" | "unconfirmed" | undefined;
  try {
    const resolved = resolveConfig();
    const binding = requireBinding(resolved);
    const config = resolveMcpConfig(resolved.env);
    const uuid = documentUuid(command.doc, config.workspaceId);
    const operations = command.command === "update" ? readOperations(command.file) : undefined;
    for (const warning of resolved.warnings) io.err(`ub: warning: ${warning}\n`);
    await ensureWorkspaceBinding(binding, resolved.env, resolved.paths.projectConfig ?? "environment");
    const instance = openWorkspaceReplicas(config, { publishOwnPresence: false, hubFree: binding.hubUrl === null });
    instance.replicas.setWriteSurface({ kind: "cli", name: "ub data" });
    try {
      if (command.command === "get") {
        const data = await readWorkspaceData(instance.replicas, uuid);
        if (command.collection === undefined) io.out(renderSummary(data));
        else {
          const collection = data?.collections.find(entry => entry.name === command.collection);
          if (collection === undefined) throw new Error(`No collection ${command.collection} in document ${uuid}`);
          const json = `${JSON.stringify({ schema: collection.schema, records: collection.records }, null, 2)}\n`;
          if (command.out === undefined) io.out(json);
          else {
            writeFileSync(command.out, json, "utf8");
            io.out(`wrote ${collection.name}: ${records(collection.records.length)}, ${number(Buffer.byteLength(json))} bytes → ${command.out}\n`);
          }
        }
      } else {
        const result = await updateWorkspaceData(instance.replicas, { uuid, operations }, command.dryRun);
        if (result.changed && !command.dryRun) saved = result.synced ? "synced" : "local";
        if (!result.changed && !command.dryRun) io.out("no change\n");
        else {
          io.out(renderChanges(result.collections, command.dryRun));
          io.out(command.dryRun ? "nothing written (dry run)\n" : result.synced
            ? "saved; synced with hub\n" : "saved locally; not yet synced with hub\n");
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceDataWriteError) saved = error.writeOutcome === "saved-locally" ? "local" : "unconfirmed";
      throw error;
    } finally { await instance.close(); }
    return 0;
  } catch (error) {
    io.err(`error: ${reason(error)}\n${command.command === "update" ? failureOutcome(error, saved) : ""}`);
    return 1;
  }
}
