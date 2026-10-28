export function vitestBudgets(name: string): {
  runner: string;
  reporters: ["dot" | "default", [string, { name: string }]];
};
