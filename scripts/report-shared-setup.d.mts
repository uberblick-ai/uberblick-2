export function measureSharedSetup<T>(name: string, phase: "setup" | "cleanup", work: () => T | Promise<T>): Promise<T>;
