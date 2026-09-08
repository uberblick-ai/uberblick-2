/**
 * The one fold every in-browser match against a document title runs.
 *
 * Both matchers over titles — the Documents page filter (`shell/DocumentList`)
 * and the `@` document picker (`editor/mention-menu`) — apply this to the typed
 * text and to the title alike, so one query means one thing for one title
 * wherever it is typed. Two copies of the rule could drift; one cannot.
 *
 * NFD decomposition, then every **non-spacing** combining mark dropped, then a
 * plain lowercase. That restores the two matches the store's own FTS5 index has
 * always made — its `unicode61` tokenizer folds diacritics, so `École` answers
 * `ecole` and `İSTANBUL` answers `istanbul` — without going further than the
 * index does. `İ` decomposes to `I` plus a combining dot the fold removes; `É`
 * to `E` plus a combining acute.
 *
 * `\p{Mn}` and not `\p{M}`, which is the difference this rule is *about*:
 * spacing marks carry the vowel of the syllable they sit on, so removing them
 * would equate words nobody would call the same — `किताब` would answer `कतब`.
 * They survive the fold, and titles differing only by one stay distinct
 * (owner decision, 2026-09-08, on #965).
 *
 * `toLowerCase`, never `toLocaleLowerCase`: the answer must not depend on the
 * machine. A Turkish locale would fold an ordinary `I` to a dotless `ı` and
 * change what every English title matches. It is a simple lowercase rather than
 * Unicode full case folding, so `STRASSE` still does not find `Straße`, and the
 * dotless `ısparta` still does not find `ISPARTA`.
 *
 * The `u` flag is load-bearing: without it `\p{Mn}` is not a property escape at
 * all, and the fold silently stops removing anything.
 */
export function foldForTitleMatch(text: string): string {
  return text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
}
