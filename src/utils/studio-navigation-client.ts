export type StudioNavigationOptions = {
  isMobile?: () => boolean;
};

export function setupStudioNavigation(document: Document, options: StudioNavigationOptions = {}) {
  const navigation = document.querySelector<HTMLElement>('[data-studio-navigation]');
  const toggle = navigation?.querySelector<HTMLButtonElement>('[data-studio-navigation-toggle]');
  const panel = navigation?.querySelector<HTMLElement>('[data-studio-navigation-panel]');
  const close = navigation?.querySelector<HTMLButtonElement>('[data-studio-navigation-close]');
  const backdrop = navigation?.querySelector<HTMLButtonElement>(
    '[data-studio-navigation-backdrop]',
  );
  const browserWindow = document.defaultView;

  if (!navigation || !toggle || !panel || !close || !backdrop || !browserWindow) return;
  if (navigation.dataset.ready === 'true') return;
  navigation.dataset.ready = 'true';

  const mobileQuery = browserWindow.matchMedia('(max-width: 920px)');
  const isMobile = options.isMobile ?? (() => mobileQuery.matches);
  const pageMain = document.querySelector<HTMLElement>('body.studio-with-navigation > main');

  const setOpen = (open: boolean, restoreFocus = false) => {
    const nextOpen = isMobile() && open;
    navigation.dataset.open = String(nextOpen);
    document.documentElement.dataset.studioNavigationOpen = String(nextOpen);
    toggle.setAttribute('aria-expanded', String(nextOpen));
    toggle.setAttribute('aria-label', nextOpen ? '关闭后台导航' : '打开后台导航');
    if (nextOpen) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
    }
    panel.inert = isMobile() && !nextOpen;
    if (pageMain) pageMain.inert = nextOpen;
    backdrop.hidden = !nextOpen;

    if (nextOpen) {
      close.focus();
    } else if (restoreFocus) {
      toggle.focus();
    }
  };

  toggle.addEventListener('click', () => {
    const nextOpen = navigation.dataset.open !== 'true';
    setOpen(nextOpen, !nextOpen);
  });
  close.addEventListener('click', () => setOpen(false, true));
  backdrop.addEventListener('click', () => setOpen(false, true));
  panel.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a[href]')) setOpen(false, true);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navigation.dataset.open === 'true') {
      setOpen(false, true);
      return;
    }

    if (event.key === 'Tab' && navigation.dataset.open === 'true') {
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hidden && !element.inert);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  const syncViewport = () => setOpen(false);
  mobileQuery.addEventListener?.('change', syncViewport);
  setOpen(false);
}
