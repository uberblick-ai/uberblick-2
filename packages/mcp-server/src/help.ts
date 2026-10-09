/** Bundled help has no replica or SDK dependency; both MCP routes read this catalog. */
import { ToolError } from "./failures.js";
import { toolHelpEntries } from "./help-examples.js";
import { conceptTopics } from "./help-topics.js";
import type { HelpTopic } from "./help-topics.js";

/** Public tool metadata with schemas already rendered at the MCP boundary. */
export interface ToolHelpContract {
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export function helpUri(topic: string): string {
  return `uberblick://help/${topic}`;
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export class HelpCatalog {
  private readonly topics = new Map<string, HelpTopic>(conceptTopics.map((topic) => [topic.id, topic]));

  /** Capture the registered schemas and prose rather than maintaining another tool definition. */
  addTool(name: string, tool: ToolHelpContract): void {
    if (this.topics.has(name)) throw new Error(`Help topic collides with registered tool: ${name}`);
    const entry = toolHelpEntries[name as keyof typeof toolHelpEntries];
    if (entry === undefined) throw new Error(`No help example and related topics for registered tool: ${name}`);
    const related = entry.related.map((id) => {
      const topic = this.topics.get(id);
      if (topic === undefined) throw new Error(`No owning help topic ${id} for ${name}`);
      return `- [${topic.title}](${helpUri(id)})`;
    }).join("\n");
    this.topics.set(name, {
      id: name,
      title: tool.title,
      description: `Purpose, arguments, example, output and constraints for ${name}.`,
      text: `# ${name}\n\n## Purpose\n\n${tool.title}\n\n## Description\n\n${tool.description}` +
        `\n\n## Arguments\n\n${jsonBlock(tool.inputSchema)}` +
        `\n\n## Example\n\nCall \`${name}\` with these arguments; replace document and block identities with returned values.\n\n${jsonBlock(entry.example)}` +
        `\n\n## Output\n\n${jsonBlock(tool.outputSchema)}` +
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
