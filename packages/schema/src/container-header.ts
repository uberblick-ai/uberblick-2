/** Header lines split only at CR/LF, leaving Unicode line separators in values. */
export function parseContainerHeader<Key extends string>(
  source: string,
  options: {
    keys: readonly Key[];
    repeatable?: readonly Key[];
    invalidHeader: string;
    error: (message: string) => Error;
    accept: (key: Key, value: string) => void;
  },
): { seen: Set<Key>; body: string } {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const seen = new Set<Key>();
  let bodyStart = lines.length;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      bodyStart = index + 1;
      break;
    }
    const match = /^([^:]+): ?(.*)$/s.exec(line);
    const key = match?.[1] as Key;
    if (match === null || !options.keys.includes(key)) throw options.error(options.invalidHeader);
    if (seen.has(key) && !options.repeatable?.includes(key)) throw options.error(`Duplicate header key: ${key}`);
    seen.add(key);
    options.accept(key, match[2] ?? "");
  }
  return { seen, body: lines.slice(bodyStart).join("\n") };
}
