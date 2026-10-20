import { isDirectoryEntryArchived, restoreDirectoryEntry } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { roomStages } from "./helpers.js";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

// Restore writes only the directory and never repins or changes document content.
export const restoreDocOperation = operation("restore_doc", inputSchema, (context, { uuid }, _request) => {
  const { replicas, requireStub, titleFor, durabilityAcross } = context;

  const stub = requireStub(uuid);
  const directory = replicas.directory();
  let affected: string[] = [];
  const { completed, stage } = roomStages(
    replicas, "restore_doc", uuid,
    room => room === directory.room ? "directory" : "other",
    () => "Restart the MCP server, then restore_doc with this UUID again. Read include_deleted listings to verify the topic's visibility.",
  );
  stage("directory", directory, () => {
    directory.doc.transact(() => {
      affected = restoreDirectoryEntry(directory.doc, uuid);
      // Ordinary archived stubs skip repair while decision stubs keep healing.
      // Republish current metadata before listing and index disagree after restore.
      for (const recordUuid of affected) replicas.republishStub(recordUuid);
    });
  });
  // Republish reconciles the index through its directory write. Hydration permits
  // indexing but does not prove success; query the store after republishing.
  return {
    uuid,
    title: titleFor(uuid, stub),
    records: affected,
    archived: isDirectoryEntryArchived(directory.doc, uuid),
    indexed: affected.every(recordUuid => replicas.hydrated(recordUuid) && replicas.indexReconciled(recordUuid)),
    ...durabilityAcross(directory, completed),
  };
});
