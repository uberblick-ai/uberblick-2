import { restoreDirectoryEntry } from "@uberblick/schema";
import { strictInput } from "../inputs.js";
import { roomStages } from "./helpers.js";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({ uuid: uuidArg });

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
      for (const recordUuid of affected) replicas.republishStub(recordUuid);
    });
  });
  // A rename or a retag that landed while the document was archived never
  // reached its stub for an ordinary document, because repair skips those
  // tombstones. Decision stub fields keep healing while archived. Catch
  // the directory up here, or the document comes back under the metadata it
  // was archived with while search answers from the newer.
  //
  // Hydration is what makes re-indexing possible; it is not proof that it
  // happened. Both have to hold, and the store gets the last word — read
  // after the republish, whose own directory write reconciles again.
  return {
    uuid,
    title: titleFor(uuid, stub),
    records: affected,
    archived: false,
    indexed: affected.every(recordUuid => replicas.hydrated(recordUuid) && replicas.indexReconciled(recordUuid)),
    ...durabilityAcross(directory, completed),
  };
});
