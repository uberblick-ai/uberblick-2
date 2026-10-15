/** Finish every dependent resource before releasing its owner, retaining failures. */
export async function closeResources(
  actions: Array<() => void | Promise<void>>,
  message: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const close of actions) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
