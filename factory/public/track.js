(() => {
  const venture = document.body?.dataset.venture;
  if (!venture) return;

  const send = (type) => {
    const payload = JSON.stringify({
      venture,
      type,
      path: window.location.pathname,
      referrer: document.referrer || '',
    });
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {});
  };

  send('pageview');

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-track]');
    if (target) send(target.dataset.track === 'cta' ? 'cta' : 'pageview');
  }, { passive: true });
})();
