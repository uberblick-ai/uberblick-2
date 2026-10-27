/** Bootstrap content for an ordinary page in the disposable workspace. */
export const scenario = {
  id: "history-restore",
  title: "Restore the second revision without losing later history",
  actor: "A workspace member with write access",
  startingState: "An existing workspace contains a document with three revisions: R1 (original), R2 (reviewed), R3 (current).",
  steps: [
    "Open document history at R3.",
    "Step back to R2, then back to R1.",
    "Return to R2, compare its named state with R3, and restore R2 from the Before column.",
    "Return to the live document and inspect history: R4 contains R2; R1, R2 and R3 remain readable.",
  ],
  expected: "Restoring R2 adds R4; it does not delete R3 or overwrite the old revisions.",
  assertions: "The browser test checks three initial revisions, both backward steps, the restored title and content, four resulting revisions, and convergence in another open client. Its remaining regression checks also cover no-op, undo, fixed comparison links and archived refusal, outside the clip.",
  testTitle: "restores a past version, syncs open clients, reports no-op and restores the pre-restore state",
  testFile: "e2e/revision-history.spec.ts",
};
