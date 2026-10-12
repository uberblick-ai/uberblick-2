import type { DecisionTopicState } from "@uberblick/schema";

export const TOPIC_STATES: Record<DecisionTopicState, string> = {
  conflict: "Conflict",
  "under-review": "Under review",
  "agent-stance": "Agent stance",
  "in-force": "In force",
  "not-yet-decided": "Not yet decided",
};
