// Login page: POST /auth/login, then go to ?next= (same-site paths only).
(function () {
  const form = document.getElementById('login-form');
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-submit');

  function nextUrl() {
    const n = new URLSearchParams(location.search).get('next');
    return n && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : '/';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    btn.disabled = true;
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username.value,
          password: form.password.value,
        }),
      });
      if (res.ok) {
        location.replace(nextUrl());
        return;
      }
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.detail || `Sign-in failed (${res.status})`;
      errEl.hidden = false;
      form.password.value = '';
      form.password.focus();
    } catch (err) {
      errEl.textContent = 'Could not reach the server';
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
})();
