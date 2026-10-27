/** The tap formula `ub update` installs; its version line names the newest client. */
const FORMULA_URL = "https://raw.githubusercontent.com/uberblick-ai/homebrew-tap/main/Formula/uberblick.rb";
/** Newest release first, so the top of the file describes the version offered. */
const RELEASE_NOTES_URL = "https://github.com/uberblick-ai/uberblick-2/blob/main/CHANGELOG.md";

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const UPDATE_CHECK_TIMEOUT_MS = 5_000;

export interface AvailableUpdate {
  current: string;
  latest: string;
  notesUrl: string;
}

export interface UpdateCheck {
  /** The last newer version read; null before the first answer, offline or up to date. */
  available(): AvailableUpdate | null;
  stop(): void;
}

function parts(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? null : match.slice(1).map(Number);
}

/** Plain x.y.z only; anything else is never offered as newer. */
export function isNewerVersion(current: string, latest: string): boolean {
  const have = parts(current);
  const offered = parts(latest);
  if (have === null || offered === null) return false;
  const step = offered.findIndex((part, index) => part !== have[index]);
  return step !== -1 && (offered[step] ?? 0) > (have[step] ?? 0);
}

export function formulaVersion(formula: string): string | null {
  return /^\s*version\s+"([^"]+)"/m.exec(formula)?.[1] ?? null;
}

/**
 * Read the tap now and then hourly, without delaying anything that waits on
 * startup. Every failure keeps the previous answer and says nothing.
 */
export function startUpdateCheck(
  current: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
): UpdateCheck {
  let latest: string | null = null;
  const check = async (): Promise<void> => {
    try {
      const response = await fetchImpl(FORMULA_URL, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
      if (!response.ok) return;
      latest = formulaVersion(await response.text()) ?? latest;
    } catch {
      // Offline, blocked or slow: no banner rather than an error.
    }
  };
  void check();
  const timer = setInterval(() => void check(), intervalMs);
  timer.unref();
  return {
    available: () => latest !== null && isNewerVersion(current, latest)
      ? { current, latest, notesUrl: RELEASE_NOTES_URL }
      : null,
    stop: () => clearInterval(timer),
  };
}
