/**
 * Fold query and title alike for mention completion: NFD, remove Mn,
 * then locale-independent lowercase. Keep spacing marks (not all M), or distinct
 * words such as किताब and कतब collapse. The Unicode flag enables Mn escapes.
 * École/ecole and İSTANBUL/istanbul match; simple lowercase does not equate
 * STRASSE/Straße or dotless ısparta/ISPARTA. Do not introduce locale collation.
 */
export function foldForTitleMatch(text: string): string {
  return text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
}
