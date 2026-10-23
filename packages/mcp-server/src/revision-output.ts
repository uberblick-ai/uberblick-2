import type { RevisionEntry } from "@uberblick/schema";

function timestampOutput(stamp: number): string {
  const date = new Date(stamp);
  if (date.getTime() !== stamp) throw new RangeError("Revision time cannot be represented as an ISO 8601 UTC string.");
  return date.toISOString();
}

function authorOutput(author: RevisionEntry["author"]) {
  return author === null ? null : {
    githubUsername: author.githubUsername,
    surface: { kind: author.surface.kind, name: author.surface.name },
  };
}

/** Project hub entries onto the MCP contract without changing the wire format. */
export function revisionOutput(entry: RevisionEntry) {
  return {
    id: entry.id,
    author: authorOutput(entry.author),
    startedAt: entry.startedAt === null ? null : timestampOutput(entry.startedAt),
    endedAt: entry.endedAt === null ? null : timestampOutput(entry.endedAt),
    name: entry.name == null ? null : {
      text: entry.name.text,
      namer: authorOutput(entry.name.namer),
      namedAt: timestampOutput(entry.name.namedAt),
      canManage: entry.name.canManage,
    },
  };
}
