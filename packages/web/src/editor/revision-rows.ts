/** Row identity and unchanged-run rules shared by both history comparisons. */
export type RevisionSide = "before" | "after";
export type RevisionRowKind = "unchanged" | "changed" | "added" | "removed" | "folded";

export interface RevisionSideCell {
  labels: string[];
  widthsOnly?: boolean;
  filler: boolean;
  spanned?: boolean;
}

export interface RevisionRow {
  kind: RevisionRowKind;
  /** Its place in the full comparison, or a folded run's first row. */
  at: number;
  heading?: string;
  fold?: { run: number; count: number };
  changed: boolean;
  /** Whole-version visual pairs are individual navigation targets. */
  separateChange?: boolean;
  before: RevisionSideCell;
  after: RevisionSideCell;
}

export interface RevisionFolding {
  collapse: boolean;
  expanded: ReadonlySet<number>;
}

/** Keep one context row beside changes; fold only runs of at least two. */
export function unchangedRuns(rows: readonly Pick<RevisionRow, "changed">[]): { start: number; end: number }[] {
  const quiet = rows.map((row, index) => !row.changed && !rows[index - 1]?.changed && !rows[index + 1]?.changed);
  const runs: { start: number; end: number }[] = [];
  quiet.forEach((value, index) => {
    if (!value) return;
    const last = runs.at(-1);
    if (last?.end === index - 1) last.end = index;
    else runs.push({ start: index, end: index });
  });
  return runs.filter((run) => run.end > run.start);
}
