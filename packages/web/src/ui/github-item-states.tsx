import { createContext, useContext } from "react";
import type { GitHubItemStates } from "../github-item-states.js";

export const GitHubItemStatesContext = createContext<GitHubItemStates | null>(null);

export function useGitHubItemStates(): GitHubItemStates | null {
  return useContext(GitHubItemStatesContext);
}
