from html import escape


def check_committee(snapshot):
    roster = snapshot.get('committee')
    if roster is None:
        return
    if (not isinstance(roster, dict) or type(roster.get('revision')) is not int or
            roster['revision'] < 1 or not isinstance(roster.get('editionTeams'), list) or
            not isinstance(roster.get('members'), list)):
        raise ValueError('Invalid committee roster')
    seen = set()
    for team in roster['editionTeams']:
        number = team['number']
        names = team['members']
        if (type(number) is not int or not 1 <= number <= 999 or number in seen or
                not isinstance(names, list) or not names or any(not valid_name(name) for name in names)):
            raise ValueError('Invalid edition roster')
        seen.add(number)
    for member in roster['members']:
        if not valid_name(member['name']) or not isinstance(member['bio'], str) or not member['bio'].strip():
            raise ValueError('Invalid committee member')


def valid_name(name):
    return isinstance(name, str) and bool(name.strip()) and len(name) <= 120


def committee_content(roster, word, edition_title):
    teams = []
    for team in sorted(roster['editionTeams'], key=lambda team: team['number'], reverse=True):
        names = ''.join(f'<strong>{escape(name)}</strong>' for name in team['members'])
        title = escape(edition_title(team['number']))
        teams.append(f'<div class="committee-team"><h3>{title}</h3><div class="people">{names}</div></div>')
    list_of_teams = ''.join(teams) or f'<p>{word("committee_no_teams")}</p>'
    members = ''.join(
        f'<div class="committee-member"><dt>{escape(item["name"])}</dt><dd>{escape(item["bio"])}</dd></div>'
        for item in roster['members']
    )
    list_of_members = f'<dl class="committee-members">{members}</dl>' if members else f'<p>{word("committee_no_members")}</p>'
    return f'''
<div class="committee-layout">
  <div class="committee-nav" role="navigation" aria-label="{word("team")}">
    <a href="#edition-teams">{word("committee_teams")}</a>
    <a href="#problem-setting-committee">{word("committee_members")}</a>
  </div>
  <div class="committee-content">
    <section id="edition-teams" data-committee-section aria-labelledby="edition-teams-title">
      <h2 id="edition-teams-title">{word("committee_teams")}</h2>{list_of_teams}
    </section>
    <section id="problem-setting-committee" data-committee-section aria-labelledby="committee-members-title">
      <h2 id="committee-members-title">{word("committee_title")}</h2>{list_of_members}
    </section>
  </div>
</div>'''
