"""Generate a static site from the editorial text. Run with Python 3."""
import argparse
import csv
import json
import re
from html import escape, unescape
from pathlib import Path
from shutil import copytree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
TEXT = json.loads((SOURCE / 'originals.json').read_text())
LABELS = dict((row[0], row[1:]) for row in csv.reader((SOURCE/'labels.tsv').read_text().splitlines(), delimiter='\t'))
LANGUAGES = [('zh-CN','简体中文'),('zh-TW','繁體中文'),('en','English'),('ja','日本語')]
PAGES = dict(zip('home about news rules schedule papers team faq contact thanks journal1 journal2 edition search'.split(),
                 'index about announcements regulations schedule papers committee faq contact acknowledgements notice-paper notice-solutions edition-2026 search'.split()))
MAIL = '<a href="mailto:avephysica@outlook.com">avephysica@outlook.com</a>'

def generate(i, lang, output):
    prefix = '' if i == 0 else '../'
    folder = output if not i else output/lang
    folder.mkdir(exist_ok=True)
    def word(key):
        return escape(LABELS[key][i])
    def link(key, label=None, cls=''):
        return f'<a class="{cls}" href="{PAGES[key]}.html">{word(label or key)}</a>'
    def file(name, label, meta):
        return f'<a class="file" download href="{prefix}resources/{name}"><strong>{word(label)}</strong><small>{meta} ↓</small></a>'
    files = (file('paper.pdf','theory','PDF · ver.1') + file('solutions.pdf','solutions','PDF · ver1.2') + file('2026.zip','allfiles','ZIP'))
    info = ' · '.join(word(k) for k in ['questions','points','hours'])
    def feed():
        return ''.join(f'<article class="entry"><time>{date}</time>{link(key)}</article>' for key,date in [('journal2','2026.07.04'),('journal1','2026.06.27')])
    def original(key):
        return '<div lang="zh-CN" class="prose">'+''.join('<p>'+escape(line)+'</p>' for line in TEXT[key])+'</div>'
    heading = lambda k: '<h2>'+word(k)+'</h2>'
    panel = lambda key, body: '<section class="panel">'+heading(key)+body+'</section>'
    facts = '<div class="facts">'+info+'</div>'
    homepage = (f'<div class="hero"><div class="hero-copy"><small>2026 · AvePhO</small><h1>{word("edition")}</h1><p>{word("lead")}</p>'
                f'{link("edition","archive","button")}</div><div class="brandart"><img src="{prefix}assets/brand.webp" alt="AvePhO"></div></div>'
                '<div class="grid">'+panel('latest',feed()+link('news','more','textlink'))+panel('resource',files)+'</div>'
                +'<div class="grid">'+panel('about','<p>'+word('advice')+'</p>'+link('about',cls='textlink'))+
                panel('schedule',facts+feed())+'</div>'+panel('jump','<div class="chips">'+''.join(link(k) for k in ['rules','team','faq','contact','thanks'])+'</div>'))
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
    for key, date, kind, attachment in [('journal1','2026-06-27 09:58','paper','theory'),('journal2','2026-07-04 12:31','solutions','solutions')]:
        bodies[key] = f'<p class="meta">{date} · AvePhO命题组 · {word("original")}</p>'+original(kind)
        if key=='journal2':
            bodies[key]+='<p class="note">'+word('history')+'</p>'
        else:
            bodies[key]+='<p><a href="https://mp.weixin.qq.com/s/pId2PQ9N6JqxYMxz5EReVQ">微信原文</a></p>'
        bodies[key]+=file(kind+'.pdf', attachment,'PDF')
    index = [{'title':LABELS[k][i],'url':PAGES[k]+'.html','text':unescape(re.sub(r'<[^>]+>',' ',body))} for k,body in bodies.items() if k not in ('search','home')]
    (folder/'search-index.js').write_text('const searchIndex = '+json.dumps(index,ensure_ascii=False)+';')
    for key,body in bodies.items():
        choices=''.join(f'<option value="{prefix}{local+"/" if j else ""}{PAGES[key]}.html" {"selected" if j==i else ""}>{name}</option>' for j,(local,name) in enumerate(LANGUAGES))
        nav=''.join(link(k,cls='active' if k==key else '') for k in ['home','news','papers','schedule','about','team'])
        content=body if key=='home' else f'<section class="sheet"><h1>{word(key)}</h1>{body}</section>'
        (folder/(PAGES[key]+'.html')).write_text(f'''<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{word(key)} · AvePhO</title><link rel="stylesheet" href="{prefix}assets/site.css"></head>
<body data-empty="{word('nothing')}"><header><div class="bar"><a class="brand" href="index.html">AvePhO</a><div class="tools">{link('search')}
<select aria-label="{word('language')}" id="lang">{choices}</select><button id="theme" aria-label="{word('theme')}" title="{word('theme')}">◐</button></div></div>
<nav>{nav}</nav></header><main>{content}</main><footer><b>AvePhO</b><div>{''.join(link(k) for k in ['rules','faq','contact','thanks'])}<a href="#">{word('top')}</a></div></footer>
<script src="{prefix}assets/site.js"></script>{'<script src="search-index.js"></script><script src="'+prefix+'assets/search.js"></script>' if key=='search' else ''}</body></html>''')
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Empty directory for a standalone public build')
    args = parser.parse_args()
    output = ROOT if args.output is None else args.output.resolve()
    if args.output is not None:
        output.mkdir(parents=True, exist_ok=True)
        if any(output.iterdir()):
            parser.error('--output must be an empty directory')
        for directory in ('assets', 'resources'):
            copytree(ROOT / directory, output / directory)
    for idx, (language, _) in enumerate(LANGUAGES):
        generate(idx, language, output)


if __name__ == '__main__':
    main()
