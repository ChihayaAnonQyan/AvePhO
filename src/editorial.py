"""Validate managed public content and render its download and article markup."""
from datetime import datetime, timedelta, timezone
from html import escape
from uuid import UUID


BEIJING = timezone(timedelta(hours=8))
PAPER_LABELS = {'paper': 'theory', 'solutions': 'solutions'}
RELEASE_LABELS = {'paper': 'publish_paper', 'solutions': 'publish_solutions'}


def require_uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError('Invalid public identifier')


def check_file_list(files):
    if not isinstance(files, list) or len(files) > 10:
        raise ValueError('Invalid attachment list')
    for item in files:
        require_uuid(item['id'])
        if not isinstance(item['name'], str) or not 1 <= len(item['name']) <= 180:
            raise ValueError('Invalid attachment name')


def check_editorial(snapshot):
    editions = snapshot.get('editorialEditions', [])
    articles = snapshot.get('articles', [])
    if not isinstance(editions, list) or not isinstance(articles, list):
        raise ValueError('Invalid editor snapshot')
    numbers = set()
    for entry in editions:
        number, year = entry['number'], entry['year']
        if (type(number) is not int or not 2 <= number <= 999 or number in numbers or
                type(year) is not int or not 2026 <= year <= 9999):
            raise ValueError('Invalid publishing edition')
        numbers.add(number)
        if not isinstance(entry['files'], dict) or entry['files'].keys() - PAPER_LABELS.keys():
            raise ValueError('Invalid publication schedule')
        for item in entry['files'].values():
            if item['id'] is not None:
                require_uuid(item['id'])
            if (not isinstance(item['version'], str) or len(item['version']) > 32 or
                    type(item['opensAt']) is not int or not 0 <= item['opensAt'] < 253402271999000):
                raise ValueError('Invalid scheduled file')
    ids = set()
    for item in articles:
        require_uuid(item['id'])
        if (item['id'] in ids or not isinstance(item['title'], str) or not 1 <= len(item['title']) <= 120 or
                not isinstance(item['body'], str) or not 1 <= len(item['body']) <= 12000 or
                datetime.fromisoformat(item['publishedAt']).utcoffset() is None):
            raise ValueError('Invalid article')
        ids.add(item['id'])
        check_file_list(item['images'])
        check_file_list(item['attachments'])


def merge_editions(legacy, editorial):
    editions = {entry['number']: entry for entry in legacy}
    for entry in editorial:
        number = entry['number']
        previous = editions.get(number, {'files': {}})
        editions[number] = {**previous, 'number': number, 'year': entry['year'], 'scheduled': entry['files']}
    return sorted(editions.values(), key=lambda entry: entry['number'], reverse=True)


def release_entry(kind, item, word, origin, now, timeline=False):
    start = datetime.fromtimestamp(item['opensAt'] / 1000, timezone.utc).astimezone(BEIJING)
    deadline = start.isoformat()
    title = word(RELEASE_LABELS[kind] if timeline else PAPER_LABELS[kind])
    label = title
    available = bool(item['id'] and origin)
    open_now = available and now >= start
    status = word('file_available') if open_now else word('file_pending')
    time_tag = f'<time datetime="{deadline}">{start:%Y-%m-%d %H:%M:%S} UTC+08:00</time>'
    if start.second == 0:
        time_tag = f'<time datetime="{deadline}">{start:%Y-%m-%d %H:%M} UTC+08:00</time>'
    if available:
        url = escape(origin + '/public/file/' + item['id'])
        label_hidden = ' hidden' if open_now else ''
        link_hidden = '' if open_now else ' hidden'
        label = (f'<span data-file-label{label_hidden}>{title}</span>'
                 f'<a data-file-link href="{url}"{link_hidden}>{title}</a>')
        status_marker = (f' data-file-opens="{deadline}" data-pending="{word("file_pending")}" '
                         f'data-available="{word("file_available")}"')
    else:
        status_marker = ''
    version = f' · PDF {escape(item["version"])}' if item['id'] else ''
    return (f'<article class="entry scheduled-release"><strong>{label}</strong>'
            f'<div class="release-meta">{time_tag}<span{status_marker}>{status}</span>{version}</div></article>')


def rich_content(body, asset_origin=''):
    base = f' data-asset-base="{escape(asset_origin + "/public/file/")}"' if asset_origin else ''
    return f'<div class="prose rich-content" lang="zh-CN" data-rich{base}>{escape(body)}</div>'


def article_content(item, word, asset_origin):
    content = f'<p class="meta"><time datetime="{escape(item["publishedAt"])}">{item["publishedAt"][:10]}</time></p>'
    content += rich_content(item['body'], asset_origin)
    if asset_origin and item['attachments']:
        content += '<h2>' + word('article_attachments') + '</h2>'
        content += ''.join(
            f'<a class="file" href="{escape(asset_origin + "/public/file/" + file["id"])}">'
            f'{escape(file["name"])} <small>PDF</small></a>' for file in item['attachments'])
    return content
