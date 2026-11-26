"""Check all local references and download integrity."""
import argparse
import json
from html.parser import HTMLParser
from pathlib import Path
from zipfile import ZipFile
from hashlib import sha256

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1])
ROOT = parser.parse_args().output.resolve()

class PageCheck(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.path = path
        self.headings = 0

    def handle_starttag(self, tag, attrs):
        self.headings += tag == 'h1'
        for name, url in attrs:
            if name in ('href', 'src') or (tag, name) == ('option', 'value'):
                if not url.startswith(('https:', 'mailto:', '#')):
                    assert (self.path.parent/url).is_file(), (self.path, url)

locales = [ROOT, ROOT/'zh-TW', ROOT/'en', ROOT/'ja']
pages = [page for locale in locales for page in locale.glob('*.html')]
announcement_pages = list(ROOT.glob('announcement-*.html'))
marker = ROOT/'release.json'
paper_revisions = json.loads(marker.read_text()).get('paperRevisions', {}) if marker.is_file() else {}
edition_names = [f'edition-{number}.html' for number in paper_revisions]
assert len(pages) == 56 + 4 * (len(announcement_pages) + len(edition_names))
for path in pages:
    check = PageCheck(path)
    check.feed(path.read_text())
    assert check.headings == 1
for path in (locale/'search-index.js' for locale in locales):
    data = json.loads(path.read_text().removeprefix('const searchIndex = ').removesuffix(';'))
    assert any('avephysica@outlook.com' in item['text'] for item in data)
    for name in [page.name for page in announcement_pages] + edition_names:
        assert (path.parent / name).is_file()
        assert any(item['url'] == name for item in data)
hashes = {'paper.pdf': 'baa7cdcd9cf12187016c4a47b078d83df17b89f8dbca95054d262a5afef30dac',
          'solutions.pdf': '335c213ee1b3eeadb48e522d8e00af05caf4ed4d92232f7db85e60b31bcd6191'}
with ZipFile(ROOT/'resources/2026.zip') as archive:
    assert archive.testzip() is None and len(archive.namelist()) == 2
    checked = set()
    for name in archive.namelist():
        file = 'solutions.pdf' if '答案' in name else 'paper.pdf'
        original = (ROOT/'resources'/file).read_bytes()
        assert archive.read(name) == original
        assert sha256(original).hexdigest() == hashes[file]
        checked.add(file)
    assert checked == hashes.keys()
for number in paper_revisions:
    folder = ROOT/'resources'/'editions'/number
    pdfs = {pdf.name for pdf in folder.glob('*.pdf')}
    assert pdfs in ({'paper.pdf'}, {'paper.pdf', 'solutions.pdf'})
    with ZipFile(folder/'all.zip') as archive:
        assert set(archive.namelist()) == pdfs
        for name in pdfs:
            assert archive.read(name) == (folder/name).read_bytes()
print(f'{len(pages)} pages, local links, search indices and original PDFs verified.')
