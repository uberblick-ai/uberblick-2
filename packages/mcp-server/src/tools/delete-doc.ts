import { decisionTopicArchived, deleteDecisionTopic, deleteDirectoryEntry, unpinDoc } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { roomStages } from "./helpers.js";
import { DOCUMENT_WRITE, operation } from "./operation.js";
import { uuidArg } from "./schemas.js";

export const inputSchema = strictInput({
  uuid: uuidArg,
  topic: z.boolean().optional().describe("True deletes every record of an archived decision topic, given its topic UUID or any record UUID; individual deletion is unavailable."),
});

export const deleteDocOperation = operation(DOCUMENT_WRITE, inputSchema, (context, { uuid, topic }) => {
  const { replicas, requireStub, titleFor, durabilityAcross } = context;
  const stub = requireStub(uuid);
  const directory = replicas.directory();
  if (stub.kind === "decision" && topic !== true) {
    throw new ToolError("decision_delete_unsupported", "One decision record cannot be deleted on its own yet. Deleting its archived topic requires topic: true.", { uuid });
  }
  if (stub.kind === "decision" ? !decisionTopicArchived(directory.doc, uuid) : stub.deleted !== true) {
    throw new ToolError("doc_not_archived", "Archive the document or whole decision topic before deleting it permanently.", { uuid });
  }
  const title = titleFor(uuid, stub);
  const sidebar = replicas.sidebar();
  const { completed, stage } = roomStages(
    replicas, "delete_doc", uuid,
    room => room === directory.room ? "directory" : room === sidebar.room ? "sidebar" : "other",
    (_purpose, failed) => failed === "directory"
      ? "The deletion mark was not saved. Restart the MCP server, then re-read the document before calling delete_doc again."
      : "Restart the MCP server and check get_sidebar. The deletion mark may already be durable; do not repeat delete_doc. Deleted pins remain hidden.",
  );
  let records = [uuid];
  stage("directory", directory, () => {
    if (stub.kind === "decision") records = deleteDecisionTopic(directory.doc, uuid);
    else deleteDirectoryEntry(directory.doc, uuid);
  });
  stage("sidebar", sidebar, () => sidebar.doc.transact(() => {
    for (const recordUuid of records) unpinDoc(sidebar.doc, recordUuid);
  }));
  return { uuid, title, records, deleted: true, ...durabilityAcross(directory, completed) };
});
