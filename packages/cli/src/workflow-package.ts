/**
 * The consumer half of the agent-workflow package format.
 *
 * Packages are data. This module reads an extracted local package or a gzipped
 * tar archive, validates its complete inventory and digest in memory, and
 * returns bytes for the adoption layer to place. It never executes content.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";

export const WORKFLOW_NAME = "uberblick-workflow";
const TAP_REPOSITORY = "uberblick-ai/homebrew-tap";
const MANIFEST_VERSION = 1;
export const DIGEST_FRAMING = "uberblick-workflow-payload-v1";
const DIGEST_ALGORITHM = "sha256";
const MANIFEST_NAME = "manifest.json";
const PAYLOAD_DIRECTORY = "payload";
const REQUIRES_PATH = ".agents/requires.json";
const REGULAR_MODE = "100644";
const EXECUTABLE_MODE = "100755";
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const WORKFLOW = /^[a-z0-9][a-z0-9-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type WorkflowMode = "100644" | "100755";

export interface WorkflowManifestEntry {
  path: string;
  mode: WorkflowMode;
}

export interface WorkflowManifest {
  manifestVersion: 1;
  workflow: string;
  version: string;
  source: { repository: string; commit: string };
  digest: { algorithm: "sha256"; framing: string; payload: string };
  payload: WorkflowManifestEntry[];
}

export interface WorkflowPackageEntry extends WorkflowManifestEntry {
  content: Buffer;
}

export interface LoadedWorkflowPackage {
  manifest: WorkflowManifest;
  entries: WorkflowPackageEntry[];
  sourceKind: "local" | "published";
}

function fail(message: string): never {
  throw new Error(`workflow package: ${message}`);
}

function exactKeys(value: object, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

export function checkedVersion(raw: unknown): string {
  if (typeof raw !== "string" || !VERSION.test(raw)) {
    fail(`version must be exactly MAJOR.MINOR.PATCH, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function checkedWorkflow(raw: unknown): string {
  if (typeof raw !== "string" || !WORKFLOW.test(raw)) {
    fail(`workflow name must use lowercase letters, digits and hyphens, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function checkedPayloadPath(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw.includes("\\")) {
    fail(`payload path ${JSON.stringify(raw)} is not canonical and repository-relative`);
  }
  if (raw.startsWith("/")) {
    fail(`payload path ${JSON.stringify(raw)} is not canonical and repository-relative`);
  }
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      fail(`payload path ${JSON.stringify(raw)} is not canonical and repository-relative`);
    }
    if (segment.toLowerCase() === ".git") {
      fail(`payload path ${JSON.stringify(raw)} may not enter Git administrative data`);
    }
  }
  return raw;
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function framed(value: string | Buffer): [Buffer, Buffer] {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return [length, bytes];
}

export function payloadDigest(entries: WorkflowPackageEntry[]): string {
  const hash = createHash(DIGEST_ALGORITHM);
  for (const entry of [...entries].sort(comparePath)) {
    for (const part of [...framed(entry.path), ...framed(entry.mode), ...framed(entry.content)]) {
      hash.update(part);
    }
  }
  return hash.digest("hex");
}

export function contentDigest(content: Buffer): string {
  return createHash(DIGEST_ALGORITHM).update(content).digest("hex");
}

export function fileMode(mode: WorkflowMode): number {
  return mode === EXECUTABLE_MODE ? 0o755 : 0o644;
}

function recordedMode(mode: number): WorkflowMode {
  return (mode & 0o111) === 0 ? REGULAR_MODE : EXECUTABLE_MODE;
}

export function readWorkflowManifest(text: string): WorkflowManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("manifest is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("manifest is not an object");
  }
  if (
    !exactKeys(parsed, ["manifestVersion", "workflow", "version", "source", "digest", "payload"]) ||
    (parsed as { manifestVersion?: unknown }).manifestVersion !== MANIFEST_VERSION
  ) {
    fail(`manifest must declare exactly version ${MANIFEST_VERSION}, workflow, version, source, digest and payload`);
  }
  const candidate = parsed as Record<string, unknown>;
  const workflow = checkedWorkflow(candidate.workflow);
  const version = checkedVersion(candidate.version);
  const source = candidate.source;
  if (
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    !exactKeys(source, ["repository", "commit"])
  ) {
    fail("manifest source must name the repository and the 40-character source commit");
  }
  const sourceRecord = source as Record<string, unknown>;
  if (
    typeof sourceRecord.repository !== "string" ||
    sourceRecord.repository === "" ||
    typeof sourceRecord.commit !== "string" ||
    !COMMIT.test(sourceRecord.commit)
  ) {
    fail("manifest source must name the repository and the 40-character source commit");
  }
  const digest = candidate.digest;
  if (
    digest === null ||
    typeof digest !== "object" ||
    Array.isArray(digest) ||
    !exactKeys(digest, ["algorithm", "framing", "payload"])
  ) {
    fail("manifest digest must name the algorithm, the framing and the payload digest");
  }
  const digestRecord = digest as Record<string, unknown>;
  if (
    digestRecord.algorithm !== DIGEST_ALGORITHM ||
    digestRecord.framing !== DIGEST_FRAMING ||
    typeof digestRecord.payload !== "string" ||
    !SHA256.test(digestRecord.payload)
  ) {
    fail(`manifest digest is not ${DIGEST_ALGORITHM}/${DIGEST_FRAMING} with a SHA-256 payload`);
  }
  if (!Array.isArray(candidate.payload) || candidate.payload.length === 0) {
    fail("manifest payload inventory is empty");
  }
  const payload: WorkflowManifestEntry[] = [];
  const aliases = new Set<string>();
  let previous: string | null = null;
  for (const raw of candidate.payload) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, ["path", "mode"])) {
      fail("every manifest payload entry must carry exactly a path and a mode");
    }
    const entry = raw as Record<string, unknown>;
    const path = checkedPayloadPath(entry.path);
    if (entry.mode !== REGULAR_MODE && entry.mode !== EXECUTABLE_MODE) {
      fail(`manifest payload entry ${path} records unsupported mode ${JSON.stringify(entry.mode)}`);
    }
    const alias = path.toLowerCase();
    if (aliases.has(alias)) fail(`manifest payload inventory duplicates or aliases ${path}`);
    aliases.add(alias);
    if (previous !== null && comparePath({ path: previous }, { path }) >= 0) {
      fail(`manifest payload inventory is not sorted at ${path}`);
    }
    previous = path;
    payload.push({ path, mode: entry.mode });
  }
  return {
    manifestVersion: 1,
    workflow,
    version,
    source: {
      repository: sourceRecord.repository as string,
      commit: sourceRecord.commit as string,
    },
    digest: {
      algorithm: "sha256",
      framing: DIGEST_FRAMING,
      payload: digestRecord.payload,
    },
    payload,
  };
}

function verifyEntries(
  manifest: WorkflowManifest,
  supplied: Map<string, { content: Buffer; mode: WorkflowMode }>,
): WorkflowPackageEntry[] {
  const declared = new Set(manifest.payload.map((entry) => entry.path));
  for (const path of supplied.keys()) {
    if (!declared.has(path)) fail(`damaged package: payload carries undeclared entry ${path}`);
  }
  const entries = manifest.payload.map((entry) => {
    const found = supplied.get(entry.path);
    if (found === undefined) fail(`damaged package: payload is missing declared entry ${entry.path}`);
    if (found.mode !== entry.mode) {
      fail(`damaged package: ${entry.path} is ${found.mode}, but the manifest records ${entry.mode}`);
    }
    return { ...entry, content: found.content };
  });
  const actual = payloadDigest(entries);
  if (actual !== manifest.digest.payload) {
    fail(`damaged package: payload digest is ${actual}, but the manifest records ${manifest.digest.payload}`);
  }
  verifyDeclaration(entries);
  return entries;
}

function stringList(value: unknown, label: string, paths: boolean): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry === "")) {
    fail(`${REQUIRES_PATH} declares no valid ${label}`);
  }
  const result = value as string[];
  if (paths) {
    const aliases = new Set<string>();
    for (const entry of result) {
      checkedPayloadPath(entry);
      const alias = entry.toLowerCase();
      if (aliases.has(alias)) fail(`${REQUIRES_PATH} ${label} duplicate or alias ${entry}`);
      aliases.add(alias);
    }
  }
  return result;
}

/** The package declaration separates workflow-owned and project-owned files. */
function verifyDeclaration(entries: WorkflowPackageEntry[]): void {
  const declaration = entries.find((entry) => entry.path === REQUIRES_PATH);
  if (declaration === undefined) fail(`damaged package: payload is missing ${REQUIRES_PATH}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(declaration.content.toString("utf8"));
  } catch {
    fail(`${REQUIRES_PATH} is not valid JSON`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !exactKeys(parsed, ["version", "bindings", "resources", "projectResources"]) ||
    (parsed as Record<string, unknown>).version !== 1
  ) {
    fail(`${REQUIRES_PATH} must declare exactly version 1, bindings, resources and projectResources`);
  }
  const value = parsed as Record<string, unknown>;
  stringList(value.bindings, "bindings", false);
  const resources = stringList(value.resources, "resources", true);
  const projectResources = stringList(value.projectResources, "projectResources", true);
  const manifestPaths = entries.map((entry) => entry.path);
  const declared = [...resources].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (declared.length !== manifestPaths.length || declared.some((path, index) => path !== manifestPaths[index])) {
    fail(`${REQUIRES_PATH} resources do not match the package payload inventory`);
  }
  const ownedAliases = new Set(resources.map((path) => path.toLowerCase()));
  for (const path of projectResources) {
    if (ownedAliases.has(path.toLowerCase())) {
      fail(`${REQUIRES_PATH} declares project resource ${path} as workflow-owned too`);
    }
  }
}

function ordinaryFile(path: string): { content: Buffer; mode: WorkflowMode } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${path} is not an ordinary file`);
  return { content: readFileSync(path), mode: recordedMode(stat.mode) };
}

function extractedPayload(directory: string): Map<string, { content: Buffer; mode: WorkflowMode }> {
  const payload = join(directory, PAYLOAD_DIRECTORY);
  const rootStat = lstatSync(payload);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`${payload} is not an ordinary directory`);
  const found = new Map<string, { content: Buffer; mode: WorkflowMode }>();
  const walk = (relative: string): void => {
    const absolute = relative === "" ? payload : join(payload, relative);
    for (const item of readdirSync(absolute, { withFileTypes: true })) {
      const child = relative === "" ? item.name : `${relative}/${item.name}`;
      checkedPayloadPath(child);
      const path = join(payload, child);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`payload entry ${child} is not an ordinary file or directory`);
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) found.set(child, ordinaryFile(path));
      else fail(`payload entry ${child} is not an ordinary file`);
    }
  };
  walk("");
  return found;
}

export function readExtractedWorkflowPackage(directory: string): Omit<LoadedWorkflowPackage, "sourceKind"> {
  const absolute = resolve(directory);
  const root = lstatSync(absolute);
  if (!root.isDirectory() || root.isSymbolicLink()) fail(`${absolute} is not an ordinary directory`);
  const rootEntries = readdirSync(absolute).sort();
  if (rootEntries.join("\n") !== `${MANIFEST_NAME}\n${PAYLOAD_DIRECTORY}`) {
    fail(`package directory must contain exactly ${MANIFEST_NAME} and ${PAYLOAD_DIRECTORY}`);
  }
  const manifestFile = ordinaryFile(join(absolute, MANIFEST_NAME));
  const manifest = readWorkflowManifest(manifestFile.content.toString("utf8"));
  return { manifest, entries: verifyEntries(manifest, extractedPayload(absolute)) };
}

function tarText(bytes: Buffer, label: string): string {
  const end = bytes.indexOf(0);
  const field = bytes.subarray(0, end === -1 ? bytes.length : end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(field);
  } catch {
    fail(`tar ${label} is not UTF-8`);
  }
}

function tarNumber(bytes: Buffer, label: string): number {
  if ((bytes[0] ?? 0) & 0x80) fail(`tar ${label} uses an unsupported base-256 number`);
  const text = tarText(bytes, label).trim();
  if (!/^[0-7]+$/.test(text)) fail(`tar ${label} is not octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`tar ${label} is outside the supported range`);
  return value;
}

function tarChecksum(header: Buffer): void {
  const expected = tarNumber(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) fail("tar header checksum does not match");
}

interface TarEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  content: Buffer;
}

/** Parse only the ordinary-file subset emitted by this project's builder. */
function readTar(archive: Buffer): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    fail("archive is not a valid gzip stream");
  }
  const entries: TarEntry[] = [];
  const aliases = new Set<string>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    tarChecksum(header);
    const magic = tarText(header.subarray(257, 263), "magic");
    if (!magic.startsWith("ustar")) fail("tar header is not ustar-compatible");
    const name = tarText(header.subarray(0, 100), "name");
    const prefix = tarText(header.subarray(345, 500), "prefix");
    const rawPath = prefix === "" ? name : `${prefix}/${name}`;
    const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    checkedPayloadPath(path);
    const alias = path.toLowerCase();
    if (aliases.has(alias)) fail(`tar archive duplicates or aliases ${path}`);
    aliases.add(alias);
    const size = tarNumber(header.subarray(124, 136), `size for ${path}`);
    const mode = tarNumber(header.subarray(100, 108), `mode for ${path}`) & 0o777;
    const typeFlag = header[156] ?? 0;
    const type = typeFlag === 0 || typeFlag === 0x30 ? "file" : typeFlag === 0x35 ? "directory" : null;
    if (type === null) fail(`tar entry ${path} is not an ordinary file or directory`);
    if (type === "directory" && size !== 0) fail(`tar directory ${path} carries content`);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) fail(`tar entry ${path} is truncated`);
    entries.push({ path, type, mode, content: Buffer.from(tar.subarray(contentStart, contentEnd)) });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) fail("tar archive is empty");
  return entries;
}

export function readArchivedWorkflowPackage(archive: Buffer): Omit<LoadedWorkflowPackage, "sourceKind"> {
  const tar = readTar(archive);
  const roots = new Set(tar.map((entry) => entry.path.split("/")[0]));
  if (roots.size !== 1) fail("archive must contain exactly one package directory");
  const root = [...roots][0] as string;
  const files = new Map(tar.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const manifestEntry = files.get(`${root}/${MANIFEST_NAME}`);
  if (manifestEntry === undefined) fail(`archive is missing ${root}/${MANIFEST_NAME}`);
  const manifest = readWorkflowManifest(manifestEntry.content.toString("utf8"));
  if (root !== `${manifest.workflow}-${manifest.version}`) {
    fail(`archive directory ${root} does not match ${manifest.workflow}@${manifest.version}`);
  }
  const supplied = new Map<string, { content: Buffer; mode: WorkflowMode }>();
  const allowedDirectories = new Set([root, `${root}/${PAYLOAD_DIRECTORY}`]);
  for (const entry of manifest.payload) {
    const segments = entry.path.split("/").slice(0, -1);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      allowedDirectories.add(
        `${root}/${PAYLOAD_DIRECTORY}/${segments.slice(0, depth).join("/")}`,
      );
    }
  }
  for (const entry of tar) {
    if (entry.type === "directory" && !allowedDirectories.has(entry.path)) {
      fail(`archive carries undeclared directory ${entry.path}`);
    }
  }
  for (const [path, entry] of files) {
    if (path === `${root}/${MANIFEST_NAME}`) continue;
    const prefix = `${root}/${PAYLOAD_DIRECTORY}/`;
    if (!path.startsWith(prefix)) fail(`archive carries undeclared file ${path}`);
    const relative = checkedPayloadPath(path.slice(prefix.length));
    supplied.set(relative, { content: entry.content, mode: recordedMode(entry.mode) });
  }
  return { manifest, entries: verifyEntries(manifest, supplied) };
}

export function workflowAssetUrl(workflow: string, version: string): string {
  if (checkedWorkflow(workflow) !== WORKFLOW_NAME) {
    fail(`published workflow ${JSON.stringify(workflow)} is unknown; use an explicit local package path`);
  }
  const checked = checkedVersion(version);
  return `https://github.com/${TAP_REPOSITORY}/releases/download/workflow-v${checked}/${WORKFLOW_NAME}-${checked}.tar.gz`;
}

export type Download = (url: string) => Promise<Buffer>;

async function defaultDownload(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    fail(`could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`could not fetch ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Resolve a published name/version or an explicit local directory/archive. */
export async function loadWorkflowPackage(
  raw: string,
  cwd: string,
  download: Download = defaultDownload,
): Promise<LoadedWorkflowPackage> {
  const published = raw.match(/^([a-z0-9][a-z0-9-]*)@(.+)$/);
  if (published !== null) {
    const workflow = published[1] as string;
    const version = checkedVersion(published[2]);
    const loaded = readArchivedWorkflowPackage(await download(workflowAssetUrl(workflow, version)));
    if (loaded.manifest.workflow !== workflow || loaded.manifest.version !== version) {
      fail(`published package declares ${loaded.manifest.workflow}@${loaded.manifest.version}, not ${raw}`);
    }
    return { ...loaded, sourceKind: "published" };
  }
  const path = resolve(cwd, raw);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    fail(`local source ${path} does not exist`);
  }
  const loaded = stat.isDirectory()
    ? readExtractedWorkflowPackage(path)
    : stat.isFile()
      ? readArchivedWorkflowPackage(readFileSync(path))
      : fail(`local source ${path} is not a package directory or archive`);
  return { ...loaded, sourceKind: "local" };
}
