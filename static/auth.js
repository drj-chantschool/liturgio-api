// Loaded first on every page: sends the browser to /login when the session
// lapses (any fetch → 401), and shows the signed-in user + Sign out in the
// header. window.currentUser resolves to the /api/me payload (or null).
(function () {
  function toLogin() {
    const here = location.pathname + location.search;
    location.href = '/login?next=' + encodeURIComponent(here);
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    if (res.status === 401) toLogin();
    return res;
  };

  window.currentUser = origFetch('/api/me')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function render(user) {
    const header = document.querySelector('header');
    if (!header || !user) return;
    // "Liturgio — Day View": the part after the dash is hidden on phones.
    const h1 = header.querySelector('h1');
    if (h1 && h1.textContent.includes(' — ')) {
      const [first, ...rest] = h1.textContent.split(' — ');
      h1.textContent = first;
      h1.append(el('span', 'h1-sub', ' — ' + rest.join(' — ')));
    }

    const badge = el('div');
    badge.id = 'auth-badge';
    const name = el('a', 'auth-name', user.display_name);
    name.href = '/profile';
    name.title = 'Profile & password';
    const role = el('span', 'auth-role', user.role_name);
    const out = el('button', 'auth-signout', 'Sign out');
    out.type = 'button';
    const signOut = async () => {
      await origFetch('/auth/logout', { method: 'POST' });
      location.href = '/login';
    };
    out.addEventListener('click', signOut);
    badge.append(name, role, out);

    // Phone: a small person-in-circle icon opening an account menu.
    const toggle = el('button', 'auth-menu-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Account menu');
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
      '<circle cx="12" cy="9.5" r="3.4" fill="currentColor"/>' +
      '<path d="M5.6 18.6c1.3-3 3.6-4.4 6.4-4.4s5.1 1.4 6.4 4.4" fill="currentColor"/></svg>';
    const menu = el('div', 'auth-menu');
    menu.hidden = true;
    const who = el('div', 'auth-menu-who');
    who.append(el('strong', null, user.display_name), el('span', null, user.role_name));
    const prof = el('a', 'auth-menu-item', 'Profile settings');
    prof.href = '/profile';
    const out2 = el('button', 'auth-menu-item', 'Sign out');
    out2.type = 'button';
    out2.addEventListener('click', signOut);
    menu.append(who, prof, out2);
    const setOpen = (open) => {
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
    document.addEventListener('click', (e) => { if (!badge.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    badge.append(toggle, menu);
    header.append(badge);
  }

  window.currentUser.then((user) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => render(user));
    } else {
      render(user);
    }
  });
})();
