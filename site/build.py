"""Build uberblick.ai from site/pages into site/out.

Standard library only:

    python3 site/build.py

Every site/pages/<path>.html is one page. It starts with a <head> block (title,
description, the page's own stylesheet) and continues with the page's main
content. The build wraps it in the document skeleton and the shell every page
shares (top bar, sidebar, footer), links the shared stylesheet and writes it to
site/out/<path>/index.html, so the page is served at /<path> with no extension
(Cloudflare Pages redirects /<path>.html there). pages/index.html is /, and
pages/404.html is the not-found page Pages serves as out/404.html. Everything
in site/static is copied to site/out as it is: the shared stylesheet, the page
stylesheets, the fonts and the Pages _headers file.

The sidebar marks the page whose path matches the link; the top bar shows the
newest release tag when git can name one (a shallow checkout shows none).
A page's <!-- recent changes --> line becomes the five newest releases from
the repository's CHANGELOG.md: each section's date and summary paragraph.

Links inside the site are root-relative (/compare, /css/landing.css), so the
output is meant to be served, not opened as files:

    python3 -m http.server 8000 --directory site/out

SITE_URL sets the origin the canonical links name (default https://uberblick.ai),
so a second Pages project can serve the same pages on another host; SITE_NOINDEX,
set to anything, adds a robots noindex meta tag for a host that search engines
should not index.
"""
import html, os, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGES, STATIC, OUT = ROOT / 'pages', ROOT / 'static', ROOT / 'out'
CHANGELOG, RECENT = ROOT.parent / 'CHANGELOG.md', '<!-- recent changes -->'
SITE = os.environ.get('SITE_URL', 'https://uberblick.ai').rstrip('/')
NOINDEX = '<meta name="robots" content="noindex">\n' if os.environ.get('SITE_NOINDEX') else ''

SKELETON = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/shared.css">
{head}{canonical}{noindex}</head>
<body>
<header class="top">
  <a class="mark" href="/">uberblick</a>
  {version}<nav aria-label="Site">
    <a href="/docs/install">Docs</a>
    <a href="/#changes">Changelog</a>
    <a href="https://github.com/uberblick-ai/uberblick-2">GitHub</a>
    <a href="https://agents.uberblick.ai">ub-agents</a>
    <a href="https://skills.uberblick.ai">Skills</a>
  </nav>
</header>
<div class="layout">
  <details class="side" open>
    <summary>Docs</summary>
    <div class="side-in">
{side}    </div>
  </details>
  <main class="main">
{body}
    <section class="blk about" id="about">
      <h2>Who builds this.</h2>
      <p>Uberblick, ub-agents and the small libraries beside them, such as wireframe and ablauf, are made by a team in Berlin that likes to find out how far AI engineering can go. What holds up in our own work becomes a framework and a few products that run on GitHub alone, so a team no longer needs Notion, Linear or Jira beside it. Take them as a starting point for your own variant. <a href="/docs/motivation">Why each of them exists</a>.</p>
      <div class="cols">
        <div><h3>Docs</h3><ul><li><a href="/docs/install">Install and update</a></li><li><a href="/docs/workspaces">Workspaces</a></li><li><a href="/docs/editor">The editor</a></li><li><a href="/docs/hub">Run a hub</a></li><li><a href="/docs/cli">CLI reference</a></li></ul></div>
        <div><h3>Agents</h3><ul><li><a href="/docs/agents">Agents over MCP</a></li><li><a href="/docs/mcp">MCP reference</a></li><li><a href="/docs/decisions">Decisions</a></li><li><a href="https://agents.uberblick.ai">ub-agents</a></li><li><a href="https://skills.uberblick.ai">Skills</a></li></ul></div>
        <div><h3>Project</h3><ul><li><a href="https://github.com/uberblick-ai/uberblick-2">GitHub</a></li><li><a href="https://github.com/uberblick-ai/uberblick-2/blob/main/CHANGELOG.md">Changelog</a></li><li><a href="https://github.com/uberblick-ai/homebrew-tap">Homebrew tap</a></li><li><a href="https://github.com/uberblick-ai/uberblick-2/blob/main/SECURITY.md">Security</a></li><li><a href="/compare">Compare</a></li></ul></div>
      </div>
    </section>
  </main>
</div>
<footer class="foot">
  <span>MIT license</span>
  <a href="https://github.com/uberblick-ai/uberblick-2">Source</a>
  <a href="https://github.com/uberblick-ai/uberblick-2/blob/main/CHANGELOG.md">Changelog</a>
  <a href="https://github.com/uberblick-ai/homebrew-tap">Homebrew tap</a>
  <a href="https://github.com/uberblick-ai/uberblick-2/blob/main/SECURITY.md">Security</a>
  <a href="https://agents.uberblick.ai">ub-agents</a>
  <a href="https://skills.uberblick.ai">Skills</a>
</footer>
<div class="toast" role="status" aria-live="polite"></div>
<script>
const toast = document.querySelector('.toast');
const copied = async (text, fallback) => {{
  try {{ await navigator.clipboard.writeText(text); toast.textContent = 'Copied'; }}
  catch {{ const r = document.createRange(); r.selectNodeContents(fallback); getSelection().removeAllRanges(); getSelection().addRange(r); toast.textContent = 'Select and copy'; }}
  toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 1400);
}};
for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', () => copied(b.getAttribute('data-copy'), b.closest('.block, .tabs').querySelector('pre')));
for (const b of document.querySelectorAll('.copy:not([data-copy])')) b.addEventListener('click', () => {{ const code = b.parentNode.querySelector('code'); copied(code.textContent, code); }});
for (const box of document.querySelectorAll('.tabs')) {{
  const tabs = box.querySelectorAll('[role="tab"]');
  for (const tab of tabs) tab.addEventListener('click', () => {{
    for (const t of tabs) {{ const on = t === tab; t.setAttribute('aria-selected', on); document.getElementById(t.getAttribute('aria-controls')).hidden = !on; }}
  }});
}}
(() => {{
  const side = document.querySelector('details.side'), wide = matchMedia('(min-width: 900px)');
  const sync = () => {{ if (wide.matches) side.open = true; }};
  sync(); wide.addEventListener('change', sync);
}})();
</script>
</body>
</html>
"""

# The sidebar: the docs, grouped, then the pages that are not docs.
SIDE = [
    (None, [('/', 'Overview')]),
    ('Start', [('/docs/motivation', 'Motivation'), ('/docs/install', 'Install and update'), ('/docs/workspaces', 'Workspaces'), ('/docs/editor', 'The editor')]),
    ('Agents', [('/docs/agents', 'Agents over MCP'), ('/docs/decisions', 'Decisions')]),
    ('Sharing', [('/docs/hub', 'Run a hub'), ('/docs/access', 'Access and membership')]),
    ('Reference', [('/docs/cli', 'CLI reference'), ('/docs/configuration', 'Configuration'), ('/docs/custom-markdown', 'Custom Markdown'), ('/docs/mcp', 'MCP reference')]),
    (None, [('/compare', 'Which tool fits your team?')]),
]


def version():
    try:
        tag = subprocess.run(['git', 'describe', '--tags', '--abbrev=0', '--match', 'v*'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ''
    return f'<a class="count" href="https://github.com/uberblick-ai/uberblick-2/releases/tag/{tag}">{tag}</a>\n  '


def recent(count=5):
    sections = re.findall(r'^## (v\S+) — (\d{4}-\d{2}-\d{2})\n\n(.+?)\n\n', CHANGELOG.read_text(), re.M | re.S)
    if len(sections) < count:
        sys.exit(f'CHANGELOG.md: expected {count} "## vX.Y.Z — YYYY-MM-DD" sections with a summary paragraph, found {len(sections)}')
    items = []
    for tag, date, summary in sections[:count]:
        text = re.sub(r'`([^`]+)`', r'<code>\1</code>', html.escape(' '.join(summary.split()), quote=False))
        items.append(f'<li><time>{date}</time><span class="tag">Release</span><span>{tag}: {text}</span></li>')
    return '\n  '.join(items)


def sidebar(path):
    def link(href, label):
        on = ' class="on"' if href == path else ''
        return f'<a{on} href="{href}">{label}</a>'
    out, groups = [], []
    for title, links in SIDE:
        if title is None:
            if groups:
                out.append('      <ul>' + ''.join(groups) + '</ul>\n')
                groups = []
            out.append('      <ul class="plain">' + ''.join(f'<li>{link(h, l)}</li>' for h, l in links) + '</ul>\n')
        else:
            groups.append(f'<li><span class="grp">{title}</span><ul>' + ''.join(f'<li>{link(h, l)}</li>' for h, l in links) + '</ul></li>')
    return ''.join(out)


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
    built, hrefs, tag = set(), set(), version()
    for page in sorted(PAGES.rglob('*.html')):
        name = page.relative_to(ROOT).as_posix()
        head, body = split(page.read_text(), name)
        if RECENT in body:
            body = body.replace(RECENT, recent())
        path, target = route(page)
        canonical = '' if path == '/404' else f'<link rel="canonical" href="{SITE}{path}">\n'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(SKELETON.format(head=head, canonical=canonical, noindex=NOINDEX, version=tag, side=sidebar(path), body=body))
        built.add(path)
        hrefs |= {h.split('#')[0] for h in re.findall(r'href="(/[^"]*)"', body + sidebar(path))}
    missing = sorted(h for h in hrefs if h and h not in built and not (OUT / h.lstrip('/')).is_file())
    print(f'built {len(built)} pages into {OUT.relative_to(ROOT.parent)}')
    if missing:
        print('linked but not written yet: ' + ', '.join(missing))


if __name__ == '__main__':
    main()
