import MarkdownIt from './vendor/markdown-it.mjs';
import katex from './vendor/katex.mjs';

const markdown = new MarkdownIt({ html: false, breaks: true });
const assetPattern = /^asset:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const renderMath = (value, displayMode) => {
  try {
    return katex.renderToString(value, {
      displayMode, output: 'mathml', trust: false, maxExpand: 100, maxSize: 10,
    });
  } catch {
    return '<code>' + markdown.utils.escapeHtml(value) + '</code>';
  }
};

function mathEnd(source, delimiter, start) {
  for (let end = source.indexOf(delimiter, start); end >= 0; end = source.indexOf(delimiter, end + delimiter.length)) {
    let backslashes = 0;
    while (source[end - backslashes - 1] === '\\') backslashes++;
    if (backslashes % 2 === 0 &&
        (delimiter !== '$' || (!/\s/.test(source[end - 1]) && !/\d/.test(source[end + 1] || '')))) return end;
  }
  return -1;
}

markdown.inline.ruler.before('escape', 'avepho_math', (state, silent) => {
  const source = state.src;
  const pair = [
    ['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$'],
  ].find(([open]) => source.startsWith(open, state.pos));
  if (!pair) return false;
  const [open, close] = pair;
  const from = state.pos + open.length;
  if (open === '$' && /\s/.test(source[from] || ' ')) return false;
  const end = mathEnd(source, close, from);
  if (end < from + 1 || !source.slice(from, end).trim()) return false;
  if (!silent) {
    const token = state.push('avepho_math', '', 0);
    token.content = source.slice(from, end);
    token.meta = open === '$$' || open === '\\[';
  }
  state.pos = end + close.length;
  return true;
});

markdown.block.ruler.before('fence', 'avepho_math_block', (state, start, limit, silent) => {
  const line = (i) => state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]);
  const open = line(start).trim();
  if (open !== '$$' && open !== '\\[') return false;
  const close = open === '$$' ? '$$' : '\\]';
  let end = start + 1;
  while (end < limit && line(end).trim() !== close) end++;
  if (end === limit) return false;
  if (silent) return true;
  const token = state.push('avepho_math_block', '', 0);
  token.content = state.getLines(start + 1, end, state.blkIndent, false);
  state.line = end + 1;
  return true;
}, { alt: ['paragraph'] });

markdown.renderer.rules.avepho_math = (tokens, index) => renderMath(tokens[index].content, tokens[index].meta);
markdown.renderer.rules.avepho_math_block = (tokens, index) => renderMath(tokens[index].content, true);

const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url) => assetPattern.test(url) || validateLink(url);
const originalImage = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const asset = assetPattern.exec(token.attrGet('src'));
  if (!asset || !env.assetBase) return markdown.utils.escapeHtml(token.content);
  token.attrSet('src', env.assetBase + asset[1]);
  token.attrSet('loading', 'lazy');
  return originalImage(tokens, index, options, env, renderer);
};
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (token.attrGet('href')?.startsWith('asset:')) token.attrSet('href', '#');
  return renderer.renderToken(tokens, index, options);
};

export function renderRich(source, assetBase = '') {
  return markdown.render(source, { assetBase });
}

if (typeof document !== 'undefined') {
  for (const content of document.querySelectorAll('[data-rich]')) {
    content.innerHTML = renderRich(content.textContent, content.dataset.assetBase || '');
  }
}
