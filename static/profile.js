// Profile page: account details (/api/me/profile) and self-service password
// change (POST /auth/password, which re-issues this browser's session cookie).
(function () {
  const $ = (id) => document.getElementById(id);
  const form = $('password-form');
  const errEl = $('pw-error');
  const okEl = $('pw-ok');
  const btn = $('pw-submit');
  let minLen = 10;

  function showError(msg) {
    okEl.hidden = true;
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  async function loadProfile() {
    try {
      const res = await fetch('/api/me/profile');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = await res.json();
      $('pf-display-name').textContent = p.display_name;
      $('pf-username').textContent = p.username;
      $('pw-username').value = p.username;
      $('pf-role').textContent = p.role_name;
      $('pf-role-notes').textContent = p.role_notes || '';
      $('pf-created').textContent = p.created_at
        ? new Date(p.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
        : '—';
      minLen = p.min_password_len || minLen;
      form.new.minLength = minLen;
      $('pw-hint').textContent =
        `At least ${minLen} characters. Changing it signs you out on every other device.`;
      $('profile-fields').hidden = false;
      $('profile-loading').hidden = true;
    } catch (err) {
      $('profile-loading').textContent = `Could not load profile (${err.message})`;
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    okEl.hidden = true;
    if (form.new.value.length < minLen) {
      showError(`Use at least ${minLen} characters.`);
      return;
    }
    if (form.new.value !== form.confirm.value) {
      showError('The new passwords differ.');
      form.confirm.focus();
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch('/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: form.current.value,
          new_password: form.new.value,
        }),
      });
      if (res.ok) {
        form.reset();
        okEl.hidden = false;
        return;
      }
      const data = await res.json().catch(() => ({}));
      const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join('; ') : data.detail;
      showError(detail || `Password change failed (${res.status})`);
      if (res.status === 403) {
        form.current.value = '';
        form.current.focus();
      }
    } catch (err) {
      showError('Could not reach the server');
    } finally {
      btn.disabled = false;
    }
  });

  loadProfile();
})();
