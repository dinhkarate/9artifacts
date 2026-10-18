// Copy buttons and the install tabs. The page works without it.
'use strict';

for (const btn of document.querySelectorAll('.copy')) {
  btn.addEventListener('click', async () => {
    const code = btn.parentElement.querySelector('code').cloneNode(true);
    for (const p of code.querySelectorAll('.prompt')) p.remove();
    const text = code.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Press ⌘C';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  });
}

for (const list of document.querySelectorAll('[role="tablist"]')) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
  };
  for (const t of tabs) {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      const next = tabs[(tabs.indexOf(t) + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  }
}
