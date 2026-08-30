import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { setupStudioNavigation } from './studio-navigation-client';

const markup = `
  <aside data-studio-navigation>
    <button data-studio-navigation-toggle aria-expanded="false"></button>
    <div data-studio-navigation-panel>
      <button data-studio-navigation-close>关闭</button>
      <a href="/studio/content/blog">博客</a><a href="/" target="_blank">网站</a>
    </div>
    <button data-studio-navigation-backdrop></button>
  </aside>
  <main>正文</main>`;

function element(window: Window, selector: string) {
  return window.document.querySelector(selector) as any;
}

function createPage() {
  const window = new Window({ url: 'https://goumin.work/studio' });
  window.document.body.innerHTML = markup;
  window.document.body.className = 'studio-with-navigation';
  return window;
}

describe('Studio 移动导航', () => {
  test('可打开、关闭并在 Escape 后恢复焦点', () => {
    const window = createPage();
    setupStudioNavigation(window.document as unknown as Document, { isMobile: () => true });

    const navigation = element(window, '[data-studio-navigation]');
    const toggle = element(window, '[data-studio-navigation-toggle]');
    const panel = element(window, '[data-studio-navigation-panel]');
    const close = element(window, '[data-studio-navigation-close]');
    const main = element(window, 'main');

    expect(panel.inert).toBe(true);
    toggle.click();
    expect(navigation.dataset.open).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.inert).toBe(false);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.hasAttribute('aria-modal')).toBe(true);
    expect(main.inert).toBe(true);
    expect(window.document.activeElement).toBe(close);

    close.click();
    expect(navigation.dataset.open).toBe('false');
    expect(window.document.activeElement).toBe(toggle);

    toggle.click();
    element(window, 'a[target="_blank"]').click();
    expect(navigation.dataset.open).toBe('false');
    expect(window.document.activeElement).toBe(toggle);
    expect(main.inert).toBe(false);

    toggle.click();

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(navigation.dataset.open).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.inert).toBe(true);
    expect(window.document.activeElement).toBe(toggle);
  });

  test('点击遮罩或普通内部链接会关闭并恢复焦点', () => {
    const window = createPage();
    setupStudioNavigation(window.document as unknown as Document, { isMobile: () => true });

    const navigation = element(window, '[data-studio-navigation]');
    const toggle = element(window, '[data-studio-navigation-toggle]');
    const backdrop = element(window, '[data-studio-navigation-backdrop]');
    const internalLink = element(window, 'a[href="/studio/content/blog"]');

    toggle.click();
    expect(backdrop.hidden).toBe(false);
    backdrop.click();
    expect(navigation.dataset.open).toBe('false');
    expect(backdrop.hidden).toBe(true);
    expect(window.document.activeElement).toBe(toggle);

    toggle.click();
    internalLink.addEventListener('click', (event: Event) => event.preventDefault());
    internalLink.click();
    expect(navigation.dataset.open).toBe('false');
    expect(window.document.activeElement).toBe(toggle);
  });

  test('Tab 与 Shift+Tab 在打开的导航内循环', () => {
    const window = createPage();
    setupStudioNavigation(window.document as unknown as Document, { isMobile: () => true });

    const toggle = element(window, '[data-studio-navigation-toggle]');
    const close = element(window, '[data-studio-navigation-close]');
    const lastLink = element(window, 'a[target="_blank"]');
    toggle.click();

    lastLink.focus();
    const forward = new window.KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    window.document.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(close);

    const backward = new window.KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.document.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(window.document.activeElement).toBe(lastLink);

    toggle.focus();
    window.document.dispatchEvent(forward);
    expect(window.document.activeElement).toBe(close);
  });

  test('从移动端切换到桌面端时恢复导航和正文可访问性', () => {
    const window = createPage();
    let mobile = true;
    let viewportChange: EventListener | undefined;
    const mediaQuery = {
      get matches() {
        return mobile;
      },
      addEventListener: (_type: string, listener: EventListener) => {
        viewportChange = listener;
      },
    };
    Object.defineProperty(window, 'matchMedia', { value: () => mediaQuery });
    setupStudioNavigation(window.document as unknown as Document);

    const navigation = element(window, '[data-studio-navigation]');
    const toggle = element(window, '[data-studio-navigation-toggle]');
    const panel = element(window, '[data-studio-navigation-panel]');
    const backdrop = element(window, '[data-studio-navigation-backdrop]');
    const main = element(window, 'main');

    toggle.click();
    expect(navigation.dataset.open).toBe('true');
    expect(main.inert).toBe(true);

    mobile = false;
    viewportChange?.(new window.Event('change') as unknown as Event);
    expect(navigation.dataset.open).toBe('false');
    expect(window.document.documentElement.dataset.studioNavigationOpen).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.inert).toBe(false);
    expect(panel.hasAttribute('role')).toBe(false);
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    expect(main.inert).toBe(false);
    expect(backdrop.hidden).toBe(true);
  });

  test('桌面端保持完整导航可访问', () => {
    const window = createPage();
    setupStudioNavigation(window.document as unknown as Document, { isMobile: () => false });

    const panel = element(window, '[data-studio-navigation-panel]');
    expect(panel.inert).toBe(false);
  });
});
