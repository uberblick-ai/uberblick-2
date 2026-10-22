/** Bundled help has no replica or SDK dependency; both MCP routes read this catalog. */
import { ToolError } from "./failures.js";
import { conceptTopics } from "./help-topics.js";
import type { HelpTopic } from "./help-topics.js";

/** A tool's example call and the concept topics that own its shared rules. */
export interface ToolHelp {
  readonly name: string;
  readonly example: Record<string, unknown>;
  readonly related: readonly string[];
  readonly details?: string;
}

/** Public tool metadata; the tool definition itself carries the schemas. */
export interface ToolHelpContract {
  title: string;
  description: string;
}

export function helpUri(topic: string): string {
  return `uberblick://help/${topic}`;
}

/** Short final pointer; the same related topics supply per-tool Related links. */
export function helpPointer(tool: string, related: readonly string[]): string {
  return `\n\nHelp: ${[tool, ...related].join(", ")}.`;
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export class HelpCatalog {
  private readonly topics = new Map<string, HelpTopic>(conceptTopics.map((topic) => [topic.id, topic]));

  /** Capture the registered schemas and prose rather than maintaining another tool definition. */
  addTool(entry: ToolHelp, tool: ToolHelpContract): void {
    const { name } = entry;
    if (this.topics.has(name)) throw new Error(`Help topic collides with registered tool: ${name}`);
    const related = entry.related.map((id) => {
      const topic = this.topics.get(id);
      if (topic === undefined) throw new Error(`No owning help topic ${id} for ${name}`);
      return `- [${topic.title}](${helpUri(id)})`;
    }).join("\n");
    this.topics.set(name, {
      id: name,
      title: tool.title,
      description: `Purpose, usage and an example call for ${name}.`,
      // The tool definition already gives the agent its description and schemas; help adds prose and an example.
      text: `# ${name}\n\n${tool.title}.\n\n${entry.details ?? tool.description}` +
        `\n\n## Example\n\nCall \`${name}\` with these arguments; replace document and block identities with returned values.\n\n${jsonBlock(entry.example)}` +
        `\n\n## Related\n\n${related}\n`,
    });
    const index = this.topics.get("tools");
    if (index === undefined) throw new Error("The help catalog must include the tool index.");
    this.topics.set("tools", {
      ...index,
      text: "# Tool index\n\nRegistered tool names are per-tool help topic ids. Read their help for the complete contract.\n\n" +
        [...this.topics.values()].filter((topic) => !conceptTopics.some(({ id }) => id === topic.id))
          .map((topic) => `- [${topic.id}](${helpUri(topic.id)}): ${topic.title}.`).join("\n") + "\n",
    });
  }

  list() {
    return [...this.topics.values()].map(({ id, title, description }) => ({ id, title, description, uri: helpUri(id) }));
  }

  get(id: string) {
    const topic = this.topics.get(id);
    return topic === undefined ? undefined : {
      topic: topic.id, title: topic.title, description: topic.description, uri: helpUri(id), text: topic.text,
    };
  }

  read(id: string) {
    const topic = this.get(id);
    if (topic === undefined) {
      throw new ToolError("unknown_help_topic", `Unknown help topic: ${id}`, {
        topic: id,
        topics: this.list().map((entry) => entry.id),
      });
    }
    return topic;
  }
}
