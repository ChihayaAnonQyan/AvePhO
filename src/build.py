"""Generate a static site from the editorial text. Run with Python 3."""
import argparse
import csv
import json
import re
from html import escape, unescape
from pathlib import Path
from shutil import copy2, copytree
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import UUID
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
TEXT = json.loads((SOURCE / 'originals.json').read_text())
MASCOTS = json.loads((SOURCE / 'mascots.json').read_text())
LABELS = dict((row[0], row[1:]) for row in csv.reader((SOURCE/'labels.tsv').read_text().splitlines(), delimiter='\t'))
LANGUAGES = [('zh-CN','简体中文'),('zh-TW','繁體中文'),('en','English'),('ja','日本語')]
PAGES = dict(zip('home about news rules schedule papers team faq contact thanks journal1 journal2 edition search'.split(),
                 'index about announcements regulations schedule papers committee faq contact acknowledgements notice-paper notice-solutions edition-2026 search'.split()))
MAIL = '<a href="mailto:avephysica@outlook.com">avephysica@outlook.com</a>'
SCHEDULE_STATES = ('upcoming', 'ongoing', 'completed')
SCHEDULE_OFFSET = '+08:00'


def schedule_datetime(text):
    if not isinstance(text, str) or not re.fullmatch(r'[2-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}', text):
        raise ValueError('Invalid schedule date and time')
    return datetime.fromisoformat(text + SCHEDULE_OFFSET)


def validate_schedule(snapshot):
    schedule = snapshot.get('editionSchedule')
    revision = snapshot.get('scheduleReleaseId')
    if schedule is None and revision is None:
        return
    if not isinstance(schedule, dict) or not isinstance(revision, str) or str(UUID(revision)) != revision:
        raise ValueError('Invalid schedule snapshot')
    number, year, events = (schedule[key] for key in ('number', 'year', 'events'))
    if (type(number) is not int or not 1 <= number <= 999 or type(year) is not int
            or not 2026 <= year <= 9999 or (number == 1 and year != 2026)):
        raise ValueError('Invalid current edition')
    if not isinstance(events, list) or len(events) > 20:
        raise ValueError('Invalid schedule entries')
    for event in events:
        starts = schedule_datetime(event['starts'])
        if event['ends'] != '' and schedule_datetime(event['ends']) <= starts:
            raise ValueError('Invalid schedule time range')
        if event['status'] not in ('auto', *SCHEDULE_STATES):
            raise ValueError('Invalid schedule status')
        titles = event['titles']
        if (not isinstance(titles, dict) or not titles.get('zh-CN')
                or titles.keys() - {lang for lang, _ in LANGUAGES}
                or any(not isinstance(title, str) or not title.strip() or len(title) > 80
                       for title in titles.values())):
            raise ValueError('Invalid schedule title')
        announcement = event['announcement']
        if not isinstance(announcement, str) or (announcement and str(UUID(announcement)) != announcement):
            raise ValueError('Invalid linked announcement')

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
    validate_schedule(snapshot)
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


def mascot_markup(locale_index, prefix, label):
    options = '\n'.join(
        f'<option value="{prefix}assets/mascots/{character["id"]}.webp" '
        f'data-character="{character["id"]}" data-lines="{escape(json.dumps(character["lines"], ensure_ascii=False))}">'
        f'{escape(character["names"][locale_index])}</option>'
        for character in MASCOTS
    )
    return f'''<aside class="mascot" popover="manual" aria-label="{label("mascot")}" hidden>
  <div class="mascot-content">
    <p id="mascot-bubble" class="mascot-bubble" lang="zh-CN" role="status" hidden></p>
    <button type="button" class="mascot-portrait" data-talk="{label("mascot_talk")}"
            aria-description="{label("mascot_move")}"
            aria-controls="mascot-bubble" aria-expanded="false">
      <img alt="" width="1706" height="2048" draggable="false">
    </button>
    <button type="button" class="mascot-settings" aria-label="{label("mascot_settings")}"
            aria-controls="mascot-controls" aria-expanded="false">⋯</button>
    <div id="mascot-controls" class="mascot-controls" hidden>
      <label for="mascot-select">{label("mascot_select")}</label>
      <select id="mascot-select">{options}</select>
      <button type="button" class="mascot-hide">{label("mascot_hide")}</button>
    </div>
  </div>
  <button type="button" class="mascot-show" hidden>{label("mascot_show")}</button>
</aside>'''


def generate(i, lang, output, announcements, editions, schedule, now, admin_url):
    prefix = '' if i == 0 else '../'
    folder = output if not i else output/lang
    folder.mkdir(exist_ok=True)
    pages = PAGES.copy()
    titles = {key: values[i] for key, values in LABELS.items()}

    def edition_title(number):
        return titles['numbered_edition'].format(
            number=chinese_number(number) if lang in ('zh-CN', 'zh-TW') else number)

    for edition in editions:
        number = edition['number']
        key = f'edition-{number}'
        pages[key] = key
        titles[key] = edition_title(number)
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
    def schedule_entry(event):
        start = schedule_datetime(event['starts'])
        end = schedule_datetime(event['ends']) if event['ends'] else None
        state = event['status']
        status_data = ''
        if state == 'auto':
            state = 'upcoming' if now < start else 'ongoing' if end and now < end else 'completed'
            labels = ' '.join(f'data-{state}="{word("schedule_" + state)}"' for state in SCHEDULE_STATES)
            status_data = f' data-starts="{start.isoformat()}" data-ends="{end.isoformat() if end else ""}" {labels}'
        def time_tag(value):
            label = value.isoformat(timespec='minutes').replace('T', ' ').split('+')[0]
            return f'<time datetime="{value.isoformat()}">{label}</time>'
        time_range = time_tag(start) + (' – ' + time_tag(end) if end else '')
        locale = lang if lang in event['titles'] else 'zh-CN'
        title = escape(event['titles'][locale])
        announcement = event['announcement']
        notice_link = link(announcement, 'related_notice') if announcement in pages else ''
        return (f'<article class="entry schedule-entry"><h3 lang="{locale}">{title}</h3>'
                f'<div class="schedule-time">{time_range} <span>UTC+08:00</span></div>'
                f'<div class="schedule-meta"><span{status_data}>{word("schedule_" + state)}</span>{notice_link}</div></article>')
    def event_rows(events):
        return ''.join(map(schedule_entry, events)) if events else '<p>' + word('no_schedule') + '</p>'
    def original(key):
        return '<div lang="zh-CN" class="prose">'+''.join('<p>'+escape(line)+'</p>' for line in TEXT[key])+'</div>'
    heading = lambda k: '<h2>'+word(k)+'</h2>'
    panel = lambda key, body: '<section class="panel">'+heading(key)+body+'</section>'
    facts = '<div class="facts">'+info+'</div>'
    current_year = schedule['year'] if schedule else 2026
    current_number = schedule['number'] if schedule else 1
    current_title = word('edition') if current_number == 1 else escape(edition_title(current_number))
    current_paper = next((edition for edition in editions
                          if edition['number'] == current_number and edition['year'] == current_year), None)
    hero_link = link('edition', 'archive', 'button')
    resource_key = 'resource'
    resource_body = files
    if current_number != 1:
        resource_key = 'papers'
        resource_body = edition_files(current_paper) if current_paper else link('papers', cls='textlink')
        hero_link = (link(f'edition-{current_number}', 'archive', 'button') if current_paper
                     else link('schedule', cls='button'))
    first_edition_dates = feed([row for row in dates if row[0] in ('journal1', 'journal2')])
    home_schedule = facts + first_edition_dates
    schedule_body = feed()
    if schedule:
        events = sorted(schedule['events'], key=lambda event: event['starts'])
        home_schedule = event_rows(events[:3]) + link('schedule', cls='textlink')
        schedule_body = (f'<h2>{current_title} · {current_year}</h2>' + event_rows(events)
                         + heading('first_schedule_history') + first_edition_dates)
    homepage = (f'<div class="hero"><div class="hero-copy"><small>{current_year} · AvePhO</small><h1>{current_title}</h1><p>{word("lead")}</p>'
                f'{hero_link}</div><div class="brandart"><img src="{prefix}assets/brand.webp" alt="AvePhO"></div></div>'
                '<div class="grid">'+panel('latest',feed(dates[:5])+link('news','more','textlink'))+panel(resource_key,resource_body)+'</div>'
                +'<div class="grid">'+panel('about','<p>'+word('advice')+'</p>'+link('about',cls='textlink'))+
                panel('schedule',home_schedule)+'</div>'+panel('jump','<div class="chips">'+''.join(link(k) for k in ['rules','team','faq','contact','thanks'])+'</div>'))
    archive = f'<p>{word("edition")} · 2026</p>{facts}{files}'
    bodies = {
        'home': homepage, 'news':feed(), 'about':'<p>'+word('lead')+'</p>'+heading('original')+original('about'),
        'rules':'<p>'+word('rulesnote')+'</p><p>'+word('advice')+'</p>'+link('about',cls='button'),
        'schedule':schedule_body, 'papers':link('edition',cls='textlink')+files,
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
        mascot = mascot_markup(i, prefix, word) if key == 'home' else ''
        (folder/(pages[key]+'.html')).write_text(f'''<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{word(key)} · AvePhO</title><link rel="stylesheet" href="{prefix}assets/site.css"></head>
<body data-empty="{word('nothing')}"><header><div class="bar"><a class="brand" href="index.html">AvePhO</a><div class="tools">{link('search')}
<select aria-label="{word('language')}" id="lang">{choices}</select><button id="theme" aria-label="{word('theme')}" title="{word('theme')}">◐</button></div></div>
<nav>{nav}</nav></header><main>{content}</main>{mascot}<footer><b>AvePhO</b><div>{''.join(link(k) for k in ['rules','faq','contact','thanks'])}{admin}<a href="#">{word('top')}</a></div></footer>
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
    now = datetime.now(timezone.utc)
    for idx, (language, _) in enumerate(LANGUAGES):
        generate(idx, language, output, release['announcements'], editions, release.get('editionSchedule'), now, args.admin_url)
    (output / 'release.json').write_text(json.dumps({
        'releaseId': release['releaseId'],
        'scheduleReleaseId': release.get('scheduleReleaseId'),
        'paperRevisions': {edition['number']: edition['revision'] for edition in editions},
    }))


if __name__ == '__main__':
    main()
