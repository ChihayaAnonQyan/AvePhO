"""Generate a static site from the editorial text. Run with Python 3."""
import argparse
import csv
import json
import re
from html import escape, unescape
from pathlib import Path
from shutil import copy2, copytree
from datetime import datetime
from urllib.parse import urlparse
from uuid import UUID
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
TEXT = json.loads((SOURCE / 'originals.json').read_text())
LABELS = dict((row[0], row[1:]) for row in csv.reader((SOURCE/'labels.tsv').read_text().splitlines(), delimiter='\t'))
LANGUAGES = [('zh-CN','简体中文'),('zh-TW','繁體中文'),('en','English'),('ja','日本語')]
PAGES = dict(zip('home about news rules schedule papers team faq contact thanks journal1 journal2 edition search'.split(),
                 'index about announcements regulations schedule papers committee faq contact acknowledgements notice-paper notice-solutions edition-2026 search'.split()))
MAIL = '<a href="mailto:avephysica@outlook.com">avephysica@outlook.com</a>'

def release_snapshot(path):
    if path is None:
        return {'releaseId': None, 'announcements': []}
    snapshot = json.loads(path.read_text())
    release_id = snapshot['releaseId']
    entries = snapshot['announcements']
    if release_id is not None and str(UUID(release_id)) != release_id:
        raise ValueError('Invalid release ID')
    if len(entries) > 100 or (entries and release_id is None):
        raise ValueError('Invalid announcement snapshot')
    seen = set()
    for entry in entries:
        key = entry['id']
        if str(UUID(key)) != key or key in seen:
            raise ValueError('Invalid or duplicate announcement ID')
        seen.add(key)
        if not 1 <= len(entry['title']) <= 120 or not 1 <= len(entry['body']) <= 5000:
            raise ValueError('Invalid announcement length')
        if datetime.fromisoformat(entry['publishedAt']).utcoffset() is None:
            raise ValueError('Publication timestamps need a timezone')
    return snapshot


def paper_catalog(output):
    editions = json.loads((SOURCE / 'papers.json').read_text())
    if not isinstance(editions, list):
        raise ValueError('Invalid paper catalog')
    numbers = set()
    for edition in editions:
        number, year, revision, files = (edition[key] for key in ('number', 'year', 'revision', 'files'))
        if type(number) is not int or not 2 <= number <= 999 or number in numbers:
            raise ValueError('Invalid or duplicate edition number')
        if type(year) is not int or not 2026 <= year <= 9999 or str(UUID(revision)) != revision:
            raise ValueError('Invalid edition year or revision')
        if not isinstance(files, dict) or 'paper' not in files or files.keys() - {'paper', 'solutions'}:
            raise ValueError('Invalid list of edition PDFs')
        source = ROOT / 'resources' / 'editions' / str(number)
        folder = output / 'resources' / 'editions' / str(number)
        pdfs = []
        for kind, version in files.items():
            if not isinstance(version, str) or not 1 <= len(version) <= 32 or not version.strip() or re.search(r'[\x00-\x1f\x7f]', version):
                raise ValueError('Invalid PDF version')
            pdf = source / (kind + '.pdf')
            with pdf.open('rb') as stream:
                if not re.fullmatch(rb'%PDF-\d\.\d', stream.read(8)):
                    raise ValueError(f'Invalid PDF: {pdf}')
            if source != folder:
                folder.mkdir(parents=True, exist_ok=True)
                pdf = Path(copy2(pdf, folder))
            pdfs.append(pdf)
        with ZipFile(folder / 'all.zip', 'w') as archive:
            for pdf in pdfs:
                archive.write(pdf, pdf.name)
        numbers.add(number)
    return sorted(editions, key=lambda item: item['number'], reverse=True)


def chinese_number(number):
    digits = '零一二三四五六七八九'
    if number < 10:
        return digits[number]
    if number < 100:
        tens, units = divmod(number, 10)
        return (digits[tens] if tens > 1 else '') + '十' + (digits[units] if units else '')
    hundreds, remainder = divmod(number, 100)
    if not remainder:
        return digits[hundreds] + '百'
    if remainder < 10:
        return digits[hundreds] + '百零' + digits[remainder]
    suffix = chinese_number(remainder)
    return digits[hundreds] + '百' + ('一' if remainder < 20 else '') + suffix


def generate(i, lang, output, announcements, editions, admin_url):
    prefix = '' if i == 0 else '../'
    folder = output if not i else output/lang
    folder.mkdir(exist_ok=True)
    pages = PAGES.copy()
    titles = {key: values[i] for key, values in LABELS.items()}
    for edition in editions:
        number = edition['number']
        key = f'edition-{number}'
        pages[key] = key
        titles[key] = titles['numbered_edition'].format(
            number=chinese_number(number) if lang in ('zh-CN', 'zh-TW') else number)
    for item in announcements:
        pages[item['id']] = 'announcement-' + item['id']
        titles[item['id']] = item['title']

    def word(key):
        return escape(titles[key])

    def link(key, label=None, cls=''):
        return f'<a class="{cls}" href="{pages[key]}.html">{word(label or key)}</a>'
    def file(name, label, meta):
        return f'<a class="file" download href="{prefix}resources/{name}"><strong>{word(label)}</strong><small>{escape(meta)} ↓</small></a>'
    files = (file('paper.pdf','theory','PDF · ver.1') + file('solutions.pdf','solutions','PDF · ver1.2') + file('2026.zip','allfiles','ZIP'))
    def edition_files(edition):
        folder = f"editions/{edition['number']}/"
        versions = edition['files']
        downloads = file(folder + 'paper.pdf', 'theory', 'PDF · ' + versions['paper'])
        if 'solutions' in versions:
            downloads += file(folder + 'solutions.pdf', 'solutions', 'PDF · ' + versions['solutions'])
        return downloads + file(folder + 'all.zip', 'allfiles', 'ZIP')
    info = ' · '.join(word(k) for k in ['questions','points','hours'])
    dates = [(item['id'], item['publishedAt'][:10].replace('-', '.')) for item in announcements]
    dates += [('journal2', '2026.07.04'), ('journal1', '2026.06.27')]
    dates.sort(key=lambda entry: entry[1], reverse=True)

    def feed(rows=dates):
        return ''.join(f'<article class="entry"><time>{date}</time>{link(key)}</article>' for key, date in rows)
    def original(key):
        return '<div lang="zh-CN" class="prose">'+''.join('<p>'+escape(line)+'</p>' for line in TEXT[key])+'</div>'
    heading = lambda k: '<h2>'+word(k)+'</h2>'
    panel = lambda key, body: '<section class="panel">'+heading(key)+body+'</section>'
    facts = '<div class="facts">'+info+'</div>'
    homepage = (f'<div class="hero"><div class="hero-copy"><small>2026 · AvePhO</small><h1>{word("edition")}</h1><p>{word("lead")}</p>'
                f'{link("edition","archive","button")}</div><div class="brandart"><img src="{prefix}assets/brand.webp" alt="AvePhO"></div></div>'
                '<div class="grid">'+panel('latest',feed(dates[:5])+link('news','more','textlink'))+panel('resource',files)+'</div>'
                +'<div class="grid">'+panel('about','<p>'+word('advice')+'</p>'+link('about',cls='textlink'))+
                panel('schedule',facts+feed([row for row in dates if row[0] in ('journal1','journal2')]))+'</div>'+panel('jump','<div class="chips">'+''.join(link(k) for k in ['rules','team','faq','contact','thanks'])+'</div>'))
    archive = f'<p>{word("edition")} · 2026</p>{facts}{files}'
    bodies = {
        'home': homepage, 'news':feed(), 'about':'<p>'+word('lead')+'</p>'+heading('original')+original('about'),
        'rules':'<p>'+word('rulesnote')+'</p><p>'+word('advice')+'</p>'+link('about',cls='button'),
        'schedule':feed(), 'papers':link('edition',cls='textlink')+files,
        'edition':archive+heading('errata')+'<p>'+word('errstate')+'</p>'+MAIL,
        'team':heading('paperteam')+'<div class="people">'+''.join('<strong>'+name+'</strong>' for name in ['l','整点薯条','羽','户山香澄'])+'</div>',
        'thanks':'<p>'+word('credit')+'</p>'+link('team',cls='textlink'),
        'contact':heading('errata')+'<p>'+word('errstate')+'</p>'+MAIL,
        'faq':''.join('<details><summary>'+word(q)+'</summary><p>'+word(a)+'</p>'+extra+'</details>' for q,a,extra in [('practice','advice',''),('downloadq','downloadanswer',link('edition'))]),
        'search':f'<label for="keyword">{word("enter")}</label><input id="keyword" type="search"><div id="results" aria-live="polite"></div>',
    }
    if editions:
        listings = []
        for edition in editions:
            key = f"edition-{edition['number']}"
            downloads = edition_files(edition)
            year = edition['year']
            bodies[key] = f'<p class="meta">{year}</p>{downloads}'
            listings.append(f'<article class="panel"><h2>{link(key)}</h2><p class="meta">{year}</p>{downloads}</article>')
        listings.append(f'<article class="panel"><h2>{link("edition")}</h2><p class="meta">2026</p>{files}</article>')
        bodies['papers'] = ''.join(listings)
    for key, date, kind, attachment in [('journal1','2026-06-27 09:58','paper','theory'),('journal2','2026-07-04 12:31','solutions','solutions')]:
        bodies[key] = f'<p class="meta">{date} · AvePhO命题组 · {word("original")}</p>'+original(kind)
        if key=='journal2':
            bodies[key]+='<p class="note">'+word('history')+'</p>'
        else:
            bodies[key]+='<p><a href="https://mp.weixin.qq.com/s/pId2PQ9N6JqxYMxz5EReVQ">微信原文</a></p>'
        bodies[key]+=file(kind+'.pdf', attachment,'PDF')
    for item in announcements:
        metadata = f'{item["publishedAt"][:10]} · {word("original")}'
        paragraphs = ''.join(f'<p>{escape(line)}</p>' for line in item['body'].splitlines() if line.strip())
        bodies[item['id']] = f'<p class="meta">{metadata}</p><div lang="zh-CN" class="prose">{paragraphs}</div>'
    index = [{'title':titles[k],'url':pages[k]+'.html','text':unescape(re.sub(r'<[^>]+>',' ',body))} for k,body in bodies.items() if k not in ('search','home')]
    (folder/'search-index.js').write_text('const searchIndex = '+json.dumps(index,ensure_ascii=False)+';')
    admin = f'<a href="{escape(admin_url)}">{word("admin")}</a>' if admin_url else ''
    for key,body in bodies.items():
        choices=''.join(f'<option value="{prefix}{local+"/" if j else ""}{pages[key]}.html" {"selected" if j==i else ""}>{name}</option>' for j,(local,name) in enumerate(LANGUAGES))
        nav=''.join(link(k,cls='active' if k==key else '') for k in ['home','news','papers','schedule','about','team'])
        content=body if key=='home' else f'<section class="sheet"><h1>{word(key)}</h1>{body}</section>'
        (folder/(pages[key]+'.html')).write_text(f'''<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{word(key)} · AvePhO</title><link rel="stylesheet" href="{prefix}assets/site.css"></head>
<body data-empty="{word('nothing')}"><header><div class="bar"><a class="brand" href="index.html">AvePhO</a><div class="tools">{link('search')}
<select aria-label="{word('language')}" id="lang">{choices}</select><button id="theme" aria-label="{word('theme')}" title="{word('theme')}">◐</button></div></div>
<nav>{nav}</nav></header><main>{content}</main><footer><b>AvePhO</b><div>{''.join(link(k) for k in ['rules','faq','contact','thanks'])}{admin}<a href="#">{word('top')}</a></div></footer>
<script src="{prefix}assets/site.js"></script>{'<script src="search-index.js"></script><script src="'+prefix+'assets/search.js"></script>' if key=='search' else ''}</body></html>''')
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Empty directory for a standalone public build')
    parser.add_argument('--announcements', type=Path, help='Public announcement snapshot from the Worker')
    parser.add_argument('--admin-url', default='', help='HTTPS link to the separate administration site')
    args = parser.parse_args()
    admin_url = urlparse(args.admin_url)
    if args.admin_url and (admin_url.scheme != 'https' or not admin_url.netloc or admin_url.username or
                           admin_url.path not in ('', '/') or admin_url.query or admin_url.fragment):
        parser.error('--admin-url must be an HTTPS origin')
    if args.announcements and args.output is None:
        parser.error('--announcements requires --output to avoid keeping withdrawn pages')
    release = release_snapshot(args.announcements)
    output = ROOT if args.output is None else args.output.resolve()
    if args.output is not None:
        output.mkdir(parents=True, exist_ok=True)
        if any(output.iterdir()):
            parser.error('--output must be an empty directory')
        copytree(ROOT / 'assets', output / 'assets')
        copytree(ROOT / 'resources', output / 'resources',
                 ignore=lambda path, _names: {'editions'} if Path(path) == ROOT / 'resources' else set())
    editions = paper_catalog(output)
    for idx, (language, _) in enumerate(LANGUAGES):
        generate(idx, language, output, release['announcements'], editions, args.admin_url)
    (output / 'release.json').write_text(json.dumps({
        'releaseId': release['releaseId'],
        'paperRevisions': {edition['number']: edition['revision'] for edition in editions},
    }))


if __name__ == '__main__':
    main()
