import type { DecisionTopicState } from "@uberblick/schema";

export const TOPIC_STATES: Record<DecisionTopicState, string> = {
  conflict: "Conflict",
  "under-review": "Under review",
  "in-force": "In force",
  "agent-stance": "Agent stance",
  "not-yet-decided": "Not yet decided",
};

export const TOPIC_STATE_ORDER: readonly DecisionTopicState[] = [
  "conflict", "under-review", "in-force", "agent-stance", "not-yet-decided",
];
