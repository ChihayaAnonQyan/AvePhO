const field = document.querySelector('#keyword');
const results = document.querySelector('#results');
function renderResults() {
  const query = field.value.trim().toLocaleLowerCase();
  results.replaceChildren();
  if (!query) return;
  for (const page of searchIndex) {
    const offset = page.text.toLocaleLowerCase().indexOf(query);
    if (offset < 0 && !page.title.toLocaleLowerCase().includes(query)) continue;
    const entry = document.createElement('article');
    entry.className = 'entry';
    const link = document.createElement('a');
    link.href = page.url;
    link.textContent = page.title;
    const snippet = document.createElement('p');
    snippet.textContent = page.text.slice(Math.max(0, offset - 15), Math.max(0, offset) + 95).trim();
    entry.append(link, snippet);
    results.append(entry);
  }
  if (!results.childElementCount) results.textContent = document.body.dataset.empty;
}
field.addEventListener('input', renderResults);
