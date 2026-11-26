const theme = document.querySelector('#theme');
const locale = document.querySelector('#lang');
function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* File mode may disable storage. */ }
}
const dark = readPref('avepho-theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
theme.setAttribute('aria-pressed', String(dark));
theme.addEventListener('click', () => {
  const active = document.documentElement.classList.toggle('dark');
  theme.setAttribute('aria-pressed', String(active));
  savePref('avepho-theme', active ? 'dark' : 'light');
});
locale.addEventListener('change', () => {
  savePref('avepho-language', String(locale.selectedIndex));
  location.href = locale.value;
});
if (document.documentElement.lang === 'zh-CN' && /\/(index\.html)?$/.test(location.pathname)) {
  const choice = Number(readPref('avepho-language'));
  if (choice > 0 && locale.options[choice]) location.replace(locale.options[choice].value);
}
const now = Date.now();
for (const status of document.querySelectorAll('[data-starts]')) {
  const { starts, ends } = status.dataset;
  const key = now < Date.parse(starts) ? 'upcoming'
    : ends && now < Date.parse(ends) ? 'ongoing' : 'completed';
  status.textContent = status.dataset[key];
}
