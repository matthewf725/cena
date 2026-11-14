(() => {
  const form = document.querySelector('#signup-form');
  const emailInput = document.querySelector('#email');
  const status = document.querySelector('#form-status');
  const submit = form.querySelector('button[type="submit"]');
  const config = window.CENA_CONFIG || {};
  const supabaseUrl = (config.SUPABASE_URL || config.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = config.SUPABASE_ANON_KEY || config.VITE_SUPABASE_ANON_KEY || '';
  const live = Boolean(supabaseUrl && supabaseKey);
  document.querySelector('#year').textContent = new Date().getFullYear();

  if (!live) {
    const note = document.createElement('div');
    note.className = 'local-note';
    note.setAttribute('role', 'note');
    note.innerHTML = '<b>Preview mode</b> · signups stay in this browser';
    document.body.append(note);
  }

  const setStatus = (message, kind = '') => {
    status.textContent = message;
    status.dataset.state = kind;
  };

  document.querySelectorAll('[data-role-link="restaurant"]').forEach(link => {
    link.addEventListener('click', () => {
      form.querySelector('input[name="role"][value="restaurant"]').checked = true;
    });
  });

  emailInput.addEventListener('input', () => {
    emailInput.removeAttribute('aria-invalid');
    if (status.dataset.state === 'error') setStatus('');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const role = form.querySelector('input[name="role"]:checked').value;
    if (!emailInput.checkValidity()) {
      emailInput.setAttribute('aria-invalid', 'true');
      setStatus(email ? 'Please enter a valid email address.' : 'Add your email address to join the list.', 'error');
      emailInput.focus();
      return;
    }

    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    submit.innerHTML = 'Joining…';
    setStatus('');
    try {
      if (live) {
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/join_waitlist`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            ...(supabaseKey.startsWith('eyJ') ? { Authorization: `Bearer ${supabaseKey}` } : {})
          },
          body: JSON.stringify({ p_email: email, p_role: role === 'restaurant' ? 'restaurant_owner' : 'customer' })
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(detail || `Request failed (${response.status})`);
        }
      } else {
        const key = 'cena_waitlist_preview';
        const entries = JSON.parse(localStorage.getItem(key) || '[]');
        const normalized = email.toLowerCase();
        const existing = entries.findIndex(entry => entry.email.toLowerCase() === normalized);
        const entry = { email, role, createdAt: new Date().toISOString() };
        if (existing >= 0) entries[existing] = entry;
        else entries.push(entry);
        localStorage.setItem(key, JSON.stringify(entries));
      }
      setStatus(live
        ? 'You’re on the list. We’ll be in touch when Cena is ready.'
        : 'Preview signup saved in this browser.', 'success');
      form.reset();
      emailInput.removeAttribute('aria-invalid');
    } catch (error) {
      console.error('Cena waitlist signup failed:', error);
      setStatus(live
        ? 'We couldn’t add you just now. Please try again in a moment.'
        : 'This browser could not save your signup. Check local storage and try again.', 'error');
    } finally {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      submit.innerHTML = 'Join the list <span aria-hidden="true">↗</span>';
    }
  });
})();
