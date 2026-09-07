/** Replica-local guidance discovery and non-durable briefing memory. */
import { performance } from "node:perf_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { exportMarkdown, getMeta, listDirectory, readDocumentTags } from "@uberblick/schema";
import { ToolError } from "./failures.js";
import { log } from "./log.js";
import type { Replicas } from "./replica.js";
import { activeTagCatalog } from "./tag-catalog.js";

export const GUIDANCE_INSTRUCTIONS =
  "Document writes require a briefing on this replica's live, hydrated documents carrying the active " +
  "catalog tag named guidance. Discover them through MCP resources at uberblick://doc/<uuid>. " +
  "A guidance_required refusal lists unread uuids and titles: read each with get_doc, then retry. " +
  "Completing the required reads starts a ten-minute process-local lease, valid even if guidance changes; " +
  "if curation removes the last unread document, the next write starts it. " +
  "After expiry, fresh reads of the current guidance are required. Restart discards the lease. " +
  "With no locally readable guidance the gate is inert. Reads, sidebar tools and sync_status are ungated; " +
  "resource reads return current Markdown but do not count toward the briefing. No briefing state is persisted.";

export class GuidanceBriefing {
  private readonly reads = new Set<string>();
  private expiresAt = 0;

  constructor(private readonly replicas: Replicas) {}

  /** No settle or room hydration: the gate must add no network wait. */
  documents(): { uuid: string; title: string }[] {
    const catalog = this.replicas.settings().doc;
    const marker = activeTagCatalog(catalog).find((tag) => tag.name === "guidance");
    if (marker === undefined) return [];
    return listDirectory(this.replicas.directory().doc).flatMap(({ uuid }) => {
      if (!this.replicas.hydrated(uuid)) return [];
      const doc = this.replicas.replica(uuid).doc;
      if (!readDocumentTags(doc, catalog).some((tag) => tag.id === marker.id)) return [];
      return [{ uuid, title: getMeta(doc).title }];
    });
  }

  private leased(): boolean {
    if (performance.now() < this.expiresAt) return true;
    if (this.expiresAt !== 0) {
      this.reads.clear();
      this.expiresAt = 0;
    }
    return false;
  }

  require(): void {
    if (this.leased()) return;
    const documents = this.documents();
    const unread = documents.filter(({ uuid }) => !this.reads.has(uuid));
    if (unread.length > 0) {
      throw new ToolError("guidance_required", "Read the workspace guidance before changing documents.", { unread });
    }
    // Curation can remove the last unread document between reads.
    if (documents.length > 0) {
      this.expiresAt = performance.now() + 10 * 60_000;
      this.reads.clear();
    }
  }

  /** Best effort: bookkeeping cannot turn a successful document read into failure. */
  recordRead(uuid: string): void {
    try {
      if (this.leased()) return;
      const documents = this.documents();
      if (!documents.some((doc) => doc.uuid === uuid)) return;
      this.reads.add(uuid);
      if (documents.every((doc) => this.reads.has(doc.uuid))) {
        // Monotonic elapsed time, independent of wall-clock corrections.
        this.expiresAt = performance.now() + 10 * 60_000;
        this.reads.clear();
      }
    } catch (error) {
      log.warn("could not record the guidance read", error);
    }
  }
}

export function registerGuidanceResources(
  server: McpServer,
  replicas: Replicas,
  briefing: GuidanceBriefing,
): void {
  server.registerResource(
    "guidance",
    new ResourceTemplate("uberblick://doc/{uuid}", {
      list: () => {
        replicas.refresh();
        return {
          resources: briefing.documents().map(({ uuid, title }) => ({
            uri: `uberblick://doc/${uuid}`,
            name: uuid,
            title,
            mimeType: "text/markdown",
            description: "Current replica-local guidance. Read with get_doc to satisfy the briefing.",
          })),
        };
      },
    }),
    { title: "Workspace guidance", mimeType: "text/markdown", description: GUIDANCE_INSTRUCTIONS },
    (uri, { uuid }) => {
      replicas.refresh();
      if (typeof uuid !== "string" || !briefing.documents().some((doc) => doc.uuid === uuid)) {
        throw new McpError(ErrorCode.InvalidParams, "No locally readable guidance at this URI; list resources again.");
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: exportMarkdown(replicas.replica(uuid).doc, { tagCatalog: replicas.settings().doc }),
        }],
      };
    },
  );
}
