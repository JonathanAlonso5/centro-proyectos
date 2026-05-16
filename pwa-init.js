/**
 * Centro de Proyectos · PWA bootstrap
 * Registra el service worker, auto-refresca datos y avisa de updates.
 */
(function () {
  const REFRESH_MS = 5 * 60 * 1000;
  let lastFocusRefresh = Date.now();

  let swRegistration = null;
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        swRegistration = reg;
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(reg);
            }
          });
        });
        // Forzar chequeo de SW nuevo cada 5 min para que detecte deploys
        // sin tener que esperar 24h del navegador.
        setInterval(() => { reg.update().catch(() => {}); }, 5 * 60 * 1000);
        // Y chequear inmediatamente al cargar (puede que ya hubiera un SW nuevo
        // esperando desde antes).
        reg.update().catch(() => {});
      }).catch(err => console.warn('SW register failed:', err));
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) { refreshing = true; location.reload(); }
    });
  }
  // Exponer función global para forzar update SW + recarga datos.
  // El botón ↻ del header la usa.
  window.cdpForceUpdate = async function () {
    if (swRegistration) {
      try { await swRegistration.update(); } catch {}
    }
    if (typeof window.cdpRefresh === 'function') {
      await window.cdpRefresh();
    }
  };

  function showUpdateBanner(reg) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-family:system-ui;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.2);cursor:pointer';
    bar.textContent = '🔄 Nueva versión disponible · pulsa para actualizar';
    bar.onclick = () => { const w = reg.waiting; if (w) w.postMessage('skipWaiting'); };
    document.body.appendChild(bar);
  }

  function maybeRefresh() {
    if (typeof window.cdpRefresh === 'function') window.cdpRefresh();
  }

  setInterval(maybeRefresh, REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const elapsed = Date.now() - lastFocusRefresh;
      if (elapsed > 60000) { maybeRefresh(); lastFocusRefresh = Date.now(); }
    }
  });

  const params = new URLSearchParams(location.search);
  const f = params.get('filter');
  if (f) localStorage.setItem('cdp-filter', f);
})();
