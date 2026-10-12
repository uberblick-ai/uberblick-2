import { readDocData } from "@uberblick/schema";
import { GuidanceBriefing } from "./briefing.js";
import type { Replicas } from "./replica.js";
import { ServerWork } from "./server-work.js";
import { createToolContext } from "./tools/context.js";
import { uuidArg } from "./tools/schemas.js";
import { inputSchema, prepareDataUpdate } from "./tools/update-data.js";

/** An attempted commit can persist document data before a later append fails. */
export class WorkspaceDataWriteError extends Error {
  constructor(readonly writeOutcome: "unconfirmed" | "saved-locally", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "WorkspaceDataWriteError";
  }
}

/** Observe a complete detached data area without paging across local states. */
export async function readWorkspaceData(replicas: Replicas, uuid: string) {
  uuid = uuidArg.parse(uuid);
  const context = createToolContext(replicas, new GuidanceBriefing(replicas), new ServerWork());
  await replicas.settle();
  return readDocData(context.requireDoc(uuid).doc);
}

/** The CLI data writer has a dedicated briefing exemption; MCP stays gated. */
export async function updateWorkspaceData(replicas: Replicas, input: unknown, dryRun = false) {
  const args = inputSchema.parse(input);
  const context = createToolContext(replicas, new GuidanceBriefing(replicas), new ServerWork());
  await replicas.settle();
  const replica = context.requireWritableDoc(args.uuid, true);
  const update = prepareDataUpdate(context, args, replica);
  if (dryRun) {
    return { uuid: args.uuid, changed: update.changed, collections: update.collections, dryRun, synced: false };
  }

  if (update.changed) {
    let writeOutcome: "unconfirmed" | "saved-locally" = "unconfirmed";
    try {
      update.commit();
      context.durability(replica);
      writeOutcome = "saved-locally";
      await replicas.sync.waitForQuiet();
      replicas.refresh();
      context.durability(replica);
    } catch (error) {
      throw new WorkspaceDataWriteError(writeOutcome, error);
    }
  } else {
    context.durability(replica);
  }
  return {
    uuid: args.uuid, changed: update.changed, collections: update.collections,
    dryRun, synced: replicas.isRoomQuiet(replica.room),
  };
}
