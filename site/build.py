"""Build uberblick.ai from site/pages into site/out.

Standard library only:

    python3 site/build.py

Every site/pages/<path>.html is one page. It starts with a <head> block (title,
description, the page's own stylesheet) and continues with the body. The build
wraps it in the document skeleton, links the shared stylesheet and writes it to
site/out/<path>/index.html, so the page is served at /<path> with no extension
(Cloudflare Pages redirects /<path>.html there). pages/index.html is /, and
pages/404.html is the not-found page Pages serves as out/404.html. Everything
in site/static is copied to site/out as it is: the shared stylesheet, the page
stylesheets, the fonts and the Pages _headers file.

Links inside the site are root-relative (/compare, /css/landing.css), so the
output is meant to be served, not opened as files:

    python3 -m http.server 8000 --directory site/out

SITE_URL sets the origin the canonical links name (default https://uberblick.ai),
so a second Pages project can serve the same pages on another host; SITE_NOINDEX,
set to anything, adds a robots noindex meta tag for a host that search engines
should not index.
"""
import os, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGES, STATIC, OUT = ROOT / 'pages', ROOT / 'static', ROOT / 'out'
SITE = os.environ.get('SITE_URL', 'https://uberblick.ai').rstrip('/')
NOINDEX = '<meta name="robots" content="noindex">\n' if os.environ.get('SITE_NOINDEX') else ''

SKELETON = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/shared.css">
{head}{canonical}{noindex}</head>
<body>
{body}
</body>
</html>
'''


def split(text, name):
    m = re.match(r'\s*<head>\n(.*?)</head>\n(.*)$', text, re.S)
    if not m:
        sys.exit(f'{name}: a page starts with a <head> block')
    head, body = m.groups()
    if '<title>' not in head:
        sys.exit(f'{name}: the <head> block has no <title>')
    return head, body.strip('\n')


def route(page):
    rel = page.relative_to(PAGES).with_suffix('')
    if rel.name == '404':
        return '/404', OUT / '404.html'
    if rel.name == 'index':
        rel = rel.parent
    path = '/' + rel.as_posix().strip('.')
    path = path.rstrip('/') or '/'
    return path, OUT / rel / 'index.html'


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(STATIC, OUT)
    built, hrefs = set(), set()
    for page in sorted(PAGES.rglob('*.html')):
        name = page.relative_to(ROOT).as_posix()
        head, body = split(page.read_text(), name)
        path, target = route(page)
        canonical = '' if path == '/404' else f'<link rel="canonical" href="{SITE}{path}">\n'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(SKELETON.format(head=head, canonical=canonical, noindex=NOINDEX, body=body))
        built.add(path)
        hrefs |= {h.split('#')[0] for h in re.findall(r'href="(/[^"]*)"', body)}
    missing = sorted(h for h in hrefs if h and h not in built and not (OUT / h.lstrip('/')).is_file())
    print(f'built {len(built)} pages into {OUT.relative_to(ROOT.parent)}')
    if missing:
        print('linked but not written yet: ' + ', '.join(missing))


if __name__ == '__main__':
    main()
