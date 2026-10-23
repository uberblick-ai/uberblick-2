import { listDirectory, readDirectoryTags } from "@uberblick/schema";
import { STARTUP_ORIENTATION } from "./help-topics.js";
import { log } from "./log.js";
import type { Replicas } from "./replica.js";
import { activeTagCatalog } from "./tag-catalog.js";

/** Read local discovery state once, without hydrating rooms or waiting for sync. */
export function startupInstructions(replicas: Replicas): string {
  try {
    const catalog = replicas.settings().doc;
    const marker = activeTagCatalog(catalog).find((tag) => tag.name === "guidance");
    if (marker === undefined) return STARTUP_ORIENTATION;
    const documents = listDirectory(replicas.directory().doc)
      .filter((entry) => readDirectoryTags(entry, catalog).some((tag) => tag.id === marker.id))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 10);
    if (documents.length === 0) return STARTUP_ORIENTATION;
    const pointers = documents.map(({ uuid, title }) => `${title} (\`${uuid}\`)`).join(", ");
    return `${STARTUP_ORIENTATION}\n\nWorkspace guidance: before your first write, read the pages that apply to your change with \`get_doc\`: ${pointers}.`;
  } catch (error) {
    log.warn("could not build the startup guidance pointers", error);
    return STARTUP_ORIENTATION;
  }
}
