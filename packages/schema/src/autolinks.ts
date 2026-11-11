import { inlineLinkTarget, isExternalHref, pushInlineRun } from "./marks.js";
import type { InlineRun } from "./types.js";

export interface WebAddress {
  /** The address itself; angle delimiters, when present, are outside this range. */
  from: number;
  to: number;
  text: string;
  href: string;
}

/** The full angle form, including unsupported schemes that must stay literal. */
export function angleAddressEnd(source: string, from: number): number | null {
  if (source[from] !== "<") return null;
  const angle = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>]*>/.exec(source.slice(from))?.[0];
  return angle === undefined ? null : from + angle.length;
}

/** GFM path punctuation, entity-looking suffixes and unmatched final parentheses. */
function trimPath(source: string): string {
  const opening = source.match(/\(/g)?.length ?? 0;
  let excess = (source.match(/\)/g)?.length ?? 0) - opening;
  let end = source.length;
  while (end > 0) {
    const character = source[end - 1] ?? "";
    if ("?!.,:*_~".includes(character)) end -= 1;
    else if (character === ")" && excess > 0) {
      end -= 1;
      excess -= 1;
    } else if (character === ";") {
      let ampersand = end - 2;
      while (ampersand >= 0 && /[A-Za-z0-9]/.test(source[ampersand] ?? "")) ampersand -= 1;
      if (ampersand === end - 2 || source[ampersand] !== "&") break;
      end = ampersand;
    } else break;
  }
  return source.slice(0, end);
}

/** Match http(s) CommonMark angle forms or GFM extended web addresses. */
export function matchWebAddress(source: string, from = 0): WebAddress | null {
  if (source[from] === "<") {
    const end = angleAddressEnd(source, from);
    if (end === null) return null;
    const text = source.slice(from + 1, end - 1);
    return [...text].every((character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127) && isExternalHref(text)
      ? { from: from + 1, to: end - 1, text, href: text } : null;
  }
  const first = source[from];
  if (first !== "h" && first !== "H" && first !== "w" && first !== "W") return null;
  if (from > 0 && !/[\s*_~(]/.test(source[from - 1] ?? "")) return null;
  const prefix = /^(?:https?:\/\/|www\.)/i.exec(source.slice(from))?.[0];
  if (prefix === undefined) return null;
  const candidate = /^[^\s<]+/.exec(source.slice(from))?.[0] ?? "";
  const text = trimPath(candidate);
  const www = /^www\./i.test(prefix);
  const tail = www ? text : text.slice(prefix.length);
  const domain = /^(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+/.exec(tail)?.[0];
  if (domain === undefined || domain.split(".").slice(-2).some((part) => part.includes("_"))) return null;
  const href = www ? `https://${text}` : text;
  return isExternalHref(href) ? { from, to: from + text.length, text, href } : null;
}

/** Address ranges in literal prose; this does not interpret Markdown formatting. */
export function findWebAddresses(source: string): WebAddress[] {
  const result: WebAddress[] = [];
  for (let from = 0; from < source.length;) {
    const angleEnd = angleAddressEnd(source, from);
    const address = matchWebAddress(source, from);
    if (address !== null) result.push(address);
    from = angleEnd ?? (address === null ? from + 1 : address.to);
  }
  return result;
}

/** Add ordinary links without changing literal prose or existing mark boundaries. */
export function linkifyInline(runs: readonly InlineRun[]): InlineRun[] {
  const source = runs.map((run) => run.text).join("");
  let offset = 0;
  const protectedRanges = runs.flatMap((run) => {
    const from = offset;
    offset += run.text.length;
    return run.marks.inlineCode === true || inlineLinkTarget(run.marks) !== undefined
      ? [{ from, to: offset }] : [];
  });
  const addresses = findWebAddresses(source).filter((address) =>
    !protectedRanges.some((range) => range.from < address.to && range.to > address.from));
  const result: InlineRun[] = [];
  offset = 0;
  let at = 0;
  for (const run of runs) {
    const end = offset + run.text.length;
    let from = offset;
    while (from < end) {
      while (addresses[at] !== undefined && (addresses[at]?.to ?? 0) <= from) at += 1;
      const address = addresses[at];
      const linked = address !== undefined && address.from <= from;
      const to = Math.min(end, address === undefined ? end : linked ? address.to : address.from);
      pushInlineRun(result, run.text.slice(from - offset, to - offset),
        linked ? { ...run.marks, link: address.href } : { ...run.marks });
      from = to;
    }
    offset = end;
  }
  return result;
}
