# uberblick.ai

The product site, built from this folder into `site/out` and served by
Cloudflare Pages. The intent behind it is the corpus page "Website:
uberblick.ai" (b243d85e-4c29-4a38-9b78-2636bc7e22f6): which pages exist, what
each holds, and the web UI conventions the site shares with the app.

```sh
python3 site/build.py                             # or: mise run site
python3 -m http.server 8000 --directory site/out  # then open http://127.0.0.1:8000/
```

- `pages/<path>.html` is the page served at `/<path>`: a `<head>` block with
  the title, description and the page's own stylesheet, then the page's main
  content. The build adds the shell every page shares (top bar with the newest
  release tag, the docs sidebar, the "Who builds this" footer); the sidebar
  links and the footer text live in `build.py`. `pages/index.html` is `/`;
  `pages/404.html` is the not-found page.
- `static/` is copied as it is: `shared.css` (the look the site shares with
  agents.uberblick.ai and skills.uberblick.ai: IBM Plex from Google Fonts, the
  violet accent, the shell, the block frame), `css/` (one stylesheet per page
  kind), `fonts/` (the web app's Geist and Fraunces files with their licences,
  used only by the landing page's demo frame, which shows the editor as it is),
  the favicon and touch icon (the same files as the web app's in
  `packages/web/public`) and `_headers`.
- The home page's Recent changes list is built from the repository's
  `CHANGELOG.md`: the five newest release sections, each with its date and
  summary paragraph. Edit the changelog, not the page.
- Links are root-relative, so serve the output rather than opening the files.
  The build lists links to pages that are not written yet.

The three sites share one layout and one footer text; agents.uberblick.ai and
skills.uberblick.ai carry their own copies of the stylesheet until they switch
to linking this one.

## Deploying

A Cloudflare Pages project connected to this repository builds the site from
`main` on every push that touches `site/` or `CHANGELOG.md`. Its settings, all
in the Pages dashboard, are a maintainer step; no token lives in the repository:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `site`, so Cloudflare's framework detection does not run against the pnpm workspace at the repository root, which it refuses to build |
| Build command | `python3 build.py`, relative to the root directory |
| Build output directory | `out`, relative to the root directory; a root directory also limits builds to pushes that change it |
| Build watch paths | include `site/*` and `CHANGELOG.md`, so a changelog-only push rebuilds the home page's Recent changes |
| Environment variable `SITE_URL` | the origin the project serves, for example `https://next.uberblick.ai`; omitted, the canonical links name `https://uberblick.ai` |
| Environment variable `SITE_NOINDEX` | set to `1` on a host search engines should not index |
| Custom domain | the host name; Cloudflare adds the DNS record when the zone is on Cloudflare, otherwise add a CNAME to the project's `pages.dev` host |

The new site runs on next.uberblick.ai first, from a project with
`SITE_URL=https://next.uberblick.ai` and `SITE_NOINDEX=1`; uberblick.ai stays as
it is until the move. Pages serves `404.html` for unknown paths and redirects
`/<path>.html` to `/<path>`, which is why the build writes extensionless pages.
