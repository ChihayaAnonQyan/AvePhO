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

const mascot = document.querySelector('.mascot');
if (mascot) {
  const picker = mascot.querySelector('#mascot-select');
  const portrait = mascot.querySelector('.mascot-portrait');
  const image = portrait.querySelector('img');
  const bubble = mascot.querySelector('#mascot-bubble');
  const content = mascot.querySelector('.mascot-content');
  const settings = mascot.querySelector('.mascot-settings');
  const controls = mascot.querySelector('#mascot-controls');
  const hide = mascot.querySelector('.mascot-hide');
  const show = mascot.querySelector('.mascot-show');
  const characters = Array.from(picker.options);
  const dialogue = characters.map(({ dataset }) => dataset.lines ? JSON.parse(dataset.lines) : [dataset.line]);
  const saved = characters.findIndex((option) => option.dataset.character === readPref('avepho-mascot'));
  picker.selectedIndex = saved >= 0 ? saved : Math.floor(Math.random() * characters.length);

  const clamp = (value) => Math.max(0, Math.min(1, value));
  const positionKey = 'avepho-mascot-position';
  const savedPosition = (readPref(positionKey) || '').split(',');
  let position = savedPosition.length === 2 && savedPosition.every((part) => part && Number.isFinite(Number(part)))
    ? savedPosition.map((part) => clamp(Number(part)))
    : [Math.random(), 0.35 + Math.random() * 0.55];
  let gesture = null;
  let suppressClick = false;

  function bounds() {
    const inset = 12;
    const { clientWidth: width, clientHeight: height } = mascot;
    const { offsetWidth: portraitWidth, offsetHeight: portraitHeight } = content;
    return {
      inset, width, height, portraitWidth, portraitHeight,
      travelX: Math.max(0, width - portraitWidth - 2 * inset),
      travelY: Math.max(0, height - portraitHeight - 2 * inset),
    };
  }

  function place() {
    if (content.hidden) return;
    const { inset, width, height, portraitWidth, portraitHeight, travelX, travelY } = bounds();
    const x = inset + position[0] * travelX;
    const y = inset + position[1] * travelY;
    content.style.left = x + 'px';
    content.style.top = y + 'px';
    const extendLeft = x + portraitWidth / 2 > width / 2;
    const extendUp = y + portraitHeight / 2 > height / 2;
    content.dataset.align = extendLeft ? 'end' : 'start';
    content.dataset.open = extendUp ? 'above' : 'below';
    const spaceX = extendLeft ? x + portraitWidth - inset : width - x - inset;
    const spaceY = extendUp ? y - inset : height - y - portraitHeight - inset;
    content.style.setProperty('--mascot-panel-width', spaceX + 'px');
    content.style.setProperty('--mascot-panel-height', Math.max(0, spaceY - 6) + 'px');
  }

  function moveTo(x, y) {
    const { inset, travelX, travelY } = bounds();
    position = [
      travelX ? clamp((x - inset) / travelX) : position[0],
      travelY ? clamp((y - inset) / travelY) : position[1],
    ];
    place();
  }

  function savePosition() {
    savePref(positionKey, position.join(','));
  }

  function setBubble(open) {
    bubble.hidden = !open;
    portrait.setAttribute('aria-expanded', String(open));
    if (!open) {
      bubble.textContent = '';
      return;
    }
    const lines = dialogue[picker.selectedIndex];
    bubble.textContent = lines[Math.floor(Math.random() * lines.length)];
  }

  function setControls(open) {
    controls.hidden = !open;
    settings.setAttribute('aria-expanded', String(open));
  }

  function updateCharacter() {
    const chosen = picker.selectedOptions[0];
    savePref('avepho-mascot', chosen.dataset.character);
    portrait.setAttribute('aria-label', portrait.dataset.talk.replace('{name}', chosen.textContent));
    if (!content.hidden) image.src = chosen.value;
    setBubble(false);
  }

  function setMascotVisible(visible) {
    content.hidden = !visible;
    show.hidden = visible;
    setControls(false);
    updateCharacter();
    place();
  }

  portrait.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    suppressClick = false;
    gesture = {
      id: event.pointerId, startX: event.clientX, startY: event.clientY,
      left: content.offsetLeft, top: content.offsetTop, moved: false,
    };
    portrait.setPointerCapture(event.pointerId);
  });
  portrait.addEventListener('pointermove', (event) => {
    if (gesture?.id !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(deltaX, deltaY) < 7) return;
    gesture.moved = true;
    portrait.dataset.dragging = 'true';
    setControls(false);
    moveTo(gesture.left + deltaX, gesture.top + deltaY);
  });
  function finishGesture(event) {
    if (gesture?.id !== event.pointerId) return;
    suppressClick = gesture.moved;
    if (gesture.moved) savePosition();
    gesture = null;
    delete portrait.dataset.dragging;
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    portrait.addEventListener(event, finishGesture);
  }
  portrait.addEventListener('click', (event) => {
    if (suppressClick && event.detail > 0) return;
    setControls(false);
    setBubble(bubble.hidden);
  });
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  portrait.addEventListener('keydown', (event) => {
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const [dx, dy] = direction;
    moveTo(content.offsetLeft + dx * 20, content.offsetTop + dy * 20);
    savePosition();
  });
  settings.addEventListener('click', () => {
    setBubble(false);
    setControls(controls.hidden);
  });
  picker.addEventListener('change', updateCharacter);
  hide.addEventListener('click', () => {
    savePref('avepho-mascot-hidden', 'true');
    setMascotVisible(false);
    show.focus();
  });
  show.addEventListener('click', () => {
    savePref('avepho-mascot-hidden', 'false');
    setMascotVisible(true);
    portrait.focus();
  });
  mascot.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!controls.hidden) {
      setControls(false);
      settings.focus();
    } else if (!bubble.hidden) {
      setBubble(false);
      portrait.focus();
    }
  });
  mascot.hidden = false;
  mascot.showPopover?.();
  setMascotVisible(readPref('avepho-mascot-hidden') !== 'true');
  window.addEventListener('resize', place);
}
