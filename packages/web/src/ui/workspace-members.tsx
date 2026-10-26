import { createContext, useContext } from "react";

const NO_MEMBERS: readonly string[] = [];
export const WorkspaceMembersContext = createContext<readonly string[]>(NO_MEMBERS);

export function useWorkspaceMembers(): readonly string[] {
  return useContext(WorkspaceMembersContext);
}
