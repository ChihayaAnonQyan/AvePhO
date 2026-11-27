export function setupCommitteeEditor({ el, api, showLogin }) {
  const form = el('committee-form');
  const teams = el('committee-teams');
  const members = el('committee-members');
  const status = el('committee-status');
  const publish = el('committee-publish');
  const check = el('committee-check');
  const live = el('committee-live');
  let state;
  let dirty = false;
  let busy = false;

  function updateButtons() {
    publish.disabled = !state?.revision || dirty || state.revision === state.publishedRevision;
    check.disabled = !state?.publishedRevision;
  }

  function edit() {
    dirty = true;
    updateButtons();
    status.textContent = '有未保存的修改。';
  }

  function appendRow(type, parent, values) {
    const row = el('committee-' + type + '-fields').content.firstElementChild.cloneNode(true);
    const fields = [...row.querySelectorAll('input, textarea')];
    fields.forEach((field, index) => { field.value = values[index]; });
    row.querySelector('.roster-remove').onclick = () => {
      row.remove();
      el('committee-add-' + type).focus();
      edit();
    };
    parent.append(row);
    return fields[0];
  }

  function fill(next) {
    state = next;
    dirty = false;
    teams.replaceChildren();
    members.replaceChildren();
    for (const team of state.draft.editionTeams) appendRow('team', teams, [team.number, team.members.join('\n')]);
    for (const member of state.draft.members) appendRow('member', members, [member.name, member.bio]);
    updateButtons();
  }

  async function run(operation) {
    if (busy) return;
    busy = true;
    form.inert = true;
    try {
      await operation();
    } catch (error) {
      if (error.status === 401) {
        state = undefined;
        form.hidden = true;
        showLogin('登录已失效，请重新登录。');
      } else status.textContent = error.message;
    } finally {
      busy = false;
      form.inert = false;
    }
  }

  async function load() {
    if (state) return;
    await run(async () => {
      status.textContent = '正在读取名单…';
      fill(await api('committee'));
      form.hidden = false;
      status.textContent = !state.revision ? '已载入现有首届名单。'
        : state.revision === state.publishedRevision ? '名单已提交发布。' : '已载入名单草稿。';
    });
  }

  form.oninput = edit;
  el('committee-add-team').onclick = () => {
    appendRow('team', teams, ['', '']).focus();
    edit();
  };
  el('committee-add-member').onclick = () => {
    appendRow('member', members, ['', '']).focus();
    edit();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      const editionTeams = Array.from(teams.children, (team) => ({
        number: team.querySelector('[name=number]').valueAsNumber,
        members: team.querySelector('[name=names]').value.split('\n').map((line) => line.trim()).filter(Boolean),
      }));
      const draftMembers = Array.from(members.children, (member) => ({
        name: member.querySelector('[name=nickname]').value,
        bio: member.querySelector('[name=bio]').value,
      }));
      fill(await api('committee/save', { revision: state.revision, draft: { editionTeams, members: draftMembers } }));
      status.textContent = '已保存草稿。';
    });
  };
  publish.onclick = () => {
    if (!confirm('将已保存的名单发布到官网？')) return;
    void run(async () => {
      const { state: next, deployed, runUrl } = await api('committee/publish', { revision: state.revision });
      fill(next);
      live.hidden = true;
      if (runUrl) el('committee-run').href = runUrl;
      status.textContent = deployed ? '已触发官网部署。部署完成后可点「核对官网」。'
        : '名单已提交，自动部署未触发。请打开部署记录，在 main 手动运行工作流，再核对官网。';
    });
  };
  check.onclick = () => void run(async () => {
    const result = await api('committee/check', {});
    status.textContent = result.live ? '官网已更新这版名单。' : '官网还未更新这版名单。请查看最新部署记录。';
    live.hidden = !result.live;
    if (result.live) {
      const url = new URL(live.href);
      url.searchParams.set('revision', state.publishedRevision);
      live.href = url.href;
    }
  });

  return { load };
}
