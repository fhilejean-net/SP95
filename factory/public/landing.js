(() => {
  const venture = document.body?.dataset.venture;
  const form = document.querySelector('form[data-signup]');
  if (!venture || !form) return;
  const status = form.querySelector('[data-form-status]');
  const submit = form.querySelector('button[type="submit"]');
  let touched = false;

  const show = (message, error = false) => {
    if (!status) return;
    status.textContent = message;
    status.style.color = error ? '#9d2b12' : '#191813';
  };

  form.querySelector('input[type="email"]')?.addEventListener('focus', () => {
    if (touched) return;
    touched = true;
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ venture, type: 'signup_start', path: location.pathname, referrer: document.referrer }),
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {});
  }, { once: true });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const consent = data.get('consent') === 'on';
    if (!email || !consent) {
      show('Renseigne une adresse et accepte la politique de confidentialité.', true);
      return;
    }
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Envoi…';
    }
    try {
      const response = await fetch(`/api/ventures/${encodeURIComponent(venture)}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, consent }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Inscription impossible');
      if (payload.status === 'already_confirmed') show('Cette adresse est déjà confirmée.');
      else if (payload.status === 'already_pending') show('Un email de confirmation t’attend déjà.');
      else show('Vérifie ta boîte mail : un lien de confirmation vient d’être envoyé.');
      form.reset();
    } catch (error) {
      show(error.message, true);
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Recevoir les nouveautés';
      }
    }
  });
})();
