/**
 * @uberblick/schema — the keystone package.
 *
 * Owns the Y.Doc layout for an uberblick document:
 *   - `meta`        Y.Map: uuid, title, tags, links-by-UUID
 *   - `blocks`      block sequence with stable block IDs
 *                   (types: paragraph, heading, code, mermaid)
 *   - `annotations` Y.Map of threads anchored via Yjs relative positions
 *
 * Runtime dependencies are limited to `yjs` and `fast-diff`.
 *
 * Scaffold placeholder — nothing is exported yet.
 */

export {};
