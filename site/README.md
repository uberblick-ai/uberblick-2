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
  the title, description and the page's own stylesheet, then the body.
  `pages/index.html` is `/`; `pages/404.html` is the not-found page.
- `static/` is copied as it is: `shared.css` (tokens, fonts, the block frame,
  shared by the sibling sites), `css/` (one stylesheet per page kind), `fonts/`
  (the web app's Geist and Fraunces files with their licences) and `_headers`.
- Links are root-relative, so serve the output rather than opening the files.
  The build lists links to pages that are not written yet.

agents.uberblick.ai and skills.uberblick.ai link `https://uberblick.ai/shared.css`
and keep only their own overrides and navigation, so the three sites read as
one. After a change merges, Cloudflare Pages rebuilds from `main` with the build
command `python3 site/build.py` and the output directory `site/out`; creating
that project and pointing the domain at it is a maintainer step.
