(() => {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(err => console.warn('SMART RIDE service worker registration failed:', err)));
  }
  const banner = document.getElementById('install-banner');
  const installButton = document.getElementById('install-app');
  const dismissButton = document.getElementById('dismiss-install');
  if (!banner || !installButton) return;
  let installPrompt = null;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone || localStorage.getItem('smartRideInstallDismissed') === 'yes') return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    banner.hidden = false;
    installButton.textContent = 'Install app';
  });
  if (isIOS) {
    banner.hidden = false;
    installButton.textContent = 'How to install';
  }
  installButton.addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      banner.hidden = true;
    } else if (isIOS) {
      alert('To install SMART RIDE on iPhone/iPad: tap the Share button in Safari, then choose “Add to Home Screen”, then tap Add.');
    } else {
      alert('To install SMART RIDE, open this site in Chrome or Edge and use the browser menu or address-bar Install option. On Android Chrome, open the menu (⋮) and choose “Install app” or “Add to Home screen”.');
    }
  });
  dismissButton?.addEventListener('click', () => {
    banner.hidden = true;
    localStorage.setItem('smartRideInstallDismissed', 'yes');
  });
  window.addEventListener('appinstalled', () => { banner.hidden = true; installPrompt = null; });
})();
