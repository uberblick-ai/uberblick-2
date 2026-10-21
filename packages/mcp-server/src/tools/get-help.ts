import { z } from "zod";
import { strictInput } from "../inputs.js";
import { UNSETTLED_READ, operation } from "./operation.js";

export const inputSchema = strictInput({
  topic: z.string().optional().describe("Help topic id or exact registered tool name. Omit to list all topics."),
});

export const getHelpOperation = operation(UNSETTLED_READ, inputSchema, (context, { topic }, _request) =>
  topic === undefined ? { topics: context.help.list() } : context.help.read(topic));
