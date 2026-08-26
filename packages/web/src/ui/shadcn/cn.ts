/**
 * Join class names. shadcn's own `cn` is `clsx` + `tailwind-merge`; this is
 * neither, on purpose.
 *
 * `clsx` earns its place when class names are built from objects and nested
 * arrays — the vendored components below pass strings. `tailwind-merge` earns
 * its place when a caller's `className` has to *beat* a component's own
 * utility for the same property; the cost is a ~5kB table of every Tailwind
 * class that has to track the framework's version. Neither is worth a runtime
 * dependency here, so the components take `className` for classes they do not
 * already set — position, width, a state hook — and the ones they do set are
 * theirs. If a real override shows up, `tailwind-merge` is the answer and this
 * file is where it goes.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
