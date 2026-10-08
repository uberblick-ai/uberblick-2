const callbacks = new Set<() => void>();

/** Resources beside a React tree, such as editor instances and their frames. */
export function onTestCleanup(callback: () => void): () => void {
  callbacks.add(callback);
  return () => {
    callbacks.delete(callback);
  };
}

export function cleanupTestResources(): void {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    callbacks.delete(callback);
    try {
      callback();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Test resource cleanup failed");
  }
}
