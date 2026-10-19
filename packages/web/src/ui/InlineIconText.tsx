import { useId } from "react";
import type { ReactElement } from "react";
import { INLINE_ICONS } from "@uberblick/schema";
import { inlineIconSvg, inlineIconTokens } from "../inline-icons.js";

export function InlineIconText({ text }: { text: string }): ReactElement {
  const id = useId();
  const tokens = inlineIconTokens(text);
  let visible = text;
  for (const token of [...tokens].reverse()) visible = visible.slice(0, token.from) + visible.slice(token.to);
  const labelled = visible.trim() === "";
  let offset = 0;
  return <span>{tokens.map((token) => {
    const before = text.slice(offset, token.from);
    offset = token.to;
    return <span key={token.from}>{before}<span className="ub-inline-icon-text" aria-hidden="true">{text.slice(token.from, token.to)}</span><span
      className="ub-inline-icon" data-icon={token.name}
      role="img" aria-label={INLINE_ICONS[token.name].label}
      aria-hidden={labelled ? undefined : true}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Only bundled vendor SVG from INLINE_ICONS enters HTML; authored text is rendered as React text.
      dangerouslySetInnerHTML={{ __html: inlineIconSvg(token.name, `${id}-${token.from}`) }}
    /></span>;
  })}{text.slice(offset)}</span>;
}
