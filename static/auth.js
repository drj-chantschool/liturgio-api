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
    const badge = el('div');
    badge.id = 'auth-badge';
    const name = el('a', 'auth-name', user.display_name);
    name.href = '/profile';
    name.title = 'Profile & password';
    badge.append(name, el('span', 'auth-role', user.role_name));
    const out = el('button', null, 'Sign out');
    out.type = 'button';
    out.addEventListener('click', async () => {
      await origFetch('/auth/logout', { method: 'POST' });
      location.href = '/login';
    });
    badge.append(out);
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
