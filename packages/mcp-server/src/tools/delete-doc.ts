import { deleteDirectoryEntry, unpinDoc } from "@uberblick/schema";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { roomStages } from "./helpers.js";
import { operation } from "./operation.js";
import { uuidArg } from "./schemas.js";

export const inputSchema = strictInput({ uuid: uuidArg });

export const deleteDocOperation = operation("delete_doc", inputSchema, (context, { uuid }) => {
  const { replicas, requireStub, titleFor, durabilityAcross } = context;
  const stub = requireStub(uuid);
  if (stub.kind === "decision") {
    throw new ToolError("decision_delete_unsupported", "Deleting decision records or topics is not supported yet.", { uuid });
  }
  if (stub.deleted !== true) {
    throw new ToolError("doc_not_archived", "Archive the document before deleting it permanently.", { uuid });
  }
  const title = titleFor(uuid, stub);
  const directory = replicas.directory();
  const sidebar = replicas.sidebar();
  const { completed, stage } = roomStages(
    replicas, "delete_doc", uuid,
    room => room === directory.room ? "directory" : room === sidebar.room ? "sidebar" : "other",
    (_purpose, failed) => failed === "directory"
      ? "The deletion mark was not saved. Restart the MCP server, then re-read the document before calling delete_doc again."
      : "Restart the MCP server and check get_sidebar. The deletion mark may already be durable; do not repeat delete_doc. Deleted pins remain hidden.",
  );
  stage("directory", directory, () => deleteDirectoryEntry(directory.doc, uuid));
  stage("sidebar", sidebar, () => unpinDoc(sidebar.doc, uuid));
  return { uuid, title, records: [uuid], deleted: true, ...durabilityAcross(directory, completed) };
});
