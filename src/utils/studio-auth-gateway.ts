import { isIP } from 'node:net';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const STUDIO_SESSION_COOKIE = '__Host-goumin-studio';
export const STUDIO_SESSION_TTL_SECONDS = 12 * 60 * 60;

const LOGIN_PATH = '/studio/login';
const SESSION_PATH = '/api/studio/session';
const LOGOUT_PATH = '/api/studio/session/logout';
const VERIFY_PATH = '/internal/studio-auth/verify';
export const STUDIO_AUTH_MAX_REQUEST_BODY_SIZE = 8_192;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1_000;

type LoginError = 'credentials' | 'rate' | 'session';

type LoginAsset = {
  body: BodyInit;
  contentType: string;
};

type StudioGatewayOptions = {
  username: string;
  password: string;
  sessionSecret: string;
  publicHost?: string;
  sessionTtlSeconds?: number;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  loginAssets?: Readonly<Record<string, LoginAsset>>;
};

type FailureState = {
  failures: number;
  resetAt: number;
};

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(value: string) {
  try {
    return new Uint8Array(Buffer.from(value, 'base64url'));
  } catch {
    return null;
  }
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function createStudioSessionToken(input: {
  secret: string;
  now?: number;
  ttlSeconds?: number;
  nonce?: Uint8Array;
}) {
  const now = input.now ?? Date.now();
  const ttlSeconds = input.ttlSeconds ?? STUDIO_SESSION_TTL_SECONDS;
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(18));
  const payload = `v1.${Math.floor(now / 1_000) + ttlSeconds}.${base64Url(nonce)}`;
  return `${payload}.${base64Url(await hmac(input.secret, payload))}`;
}

export async function verifyStudioSessionToken(input: {
  token: string | undefined;
  secret: string;
  now?: number;
}) {
  if (!input.token || input.token.length > 512) return false;
  const parts = input.token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;

  const expiresAt = Number(parts[1]);
  const nonce = decodeBase64Url(parts[2] ?? '');
  const signature = decodeBase64Url(parts[3] ?? '');
  if (!Number.isSafeInteger(expiresAt) || nonce?.length !== 18 || signature?.length !== 32) {
    return false;
  }
  if (expiresAt <= Math.floor((input.now ?? Date.now()) / 1_000)) return false;

  const payload = parts.slice(0, 3).join('.');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload));
}

export async function verifyStudioCredentials(input: {
  username: string;
  password: string;
  expectedUsername: string;
  expectedPassword: string;
}) {
  const supplied = encoder.encode(`${input.username}\u0000${input.password}`);
  const expected = encoder.encode(`${input.expectedUsername}\u0000${input.expectedPassword}`);
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', supplied),
    crypto.subtle.digest('SHA-256', expected),
  ]);
  const left = new Uint8Array(suppliedDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function normalizeStudioNextPath(value: string | null | undefined) {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f]/.test(value)
  ) {
    return '/studio';
  }

  try {
    const parsed = new URL(value, 'https://studio.goumin.work');
    const isStudioPage = parsed.pathname === '/studio' || parsed.pathname.startsWith('/studio/');
    const isPreviewPage = parsed.pathname === '/preview' || parsed.pathname.startsWith('/preview/');
    if (!isStudioPage && !isPreviewPage) return '/studio';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/studio';
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function requestHost(request: Request) {
  return (request.headers.get('host') || new URL(request.url).host).split(':')[0]!.toLowerCase();
}

function isLoopbackHost(host: string) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isAllowedHost(request: Request, publicHost: string) {
  const host = requestHost(request);
  return host === publicHost || isLoopbackHost(host);
}

function isAllowedFormOrigin(request: Request, publicHost: string) {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  try {
    const parsed = new URL(origin);
    if (parsed.origin.toLowerCase() === `https://${publicHost}`) return true;
    return (
      parsed.protocol === 'http:' &&
      isLoopbackHost(parsed.hostname.toLowerCase()) &&
      isLoopbackHost(requestHost(request))
    );
  } catch {
    return false;
  }
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>();
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies.set(key, value);
  }
  return cookies;
}

function nonce(randomBytes: (length: number) => Uint8Array) {
  return base64Url(randomBytes(18));
}

function securityHeaders(contentNonce?: string) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  });
  if (contentNonce) {
    headers.set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${contentNonce}'; script-src 'nonce-${contentNonce}'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
  }
  return headers;
}

function privateTextResponse(body: string, status: number) {
  const headers = securityHeaders();
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(body, { headers, status });
}

function loginErrorMessage(error: LoginError | null) {
  if (error === 'rate') return '尝试次数过多，请稍后再试。';
  if (error === 'session') return '登录状态已过期，请重新验证。';
  if (error === 'credentials') return '账号或密码不正确，请重试。';
  return null;
}

export function renderStudioLoginPage(input: {
  nextPath: string;
  error?: LoginError | null;
  nonce: string;
  username?: string;
}) {
  const nextPath = escapeHtml(normalizeStudioNextPath(input.nextPath));
  const username = escapeHtml(input.username ?? 'goumin');
  const errorMessage = loginErrorMessage(input.error ?? null);
  const errorMarkup = errorMessage
    ? `<div class="login-alert" role="alert"><span aria-hidden="true">!</span><p>${escapeHtml(errorMessage)}</p></div>`
    : '';

  return `<!doctype html>
<html lang="zh-CN" data-palette="blue-soft">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow,noarchive">
    <meta name="theme-color" content="#fdfdf9">
    <title>登录创作中心 · Gou Min</title>
    <script nonce="${input.nonce}">(()=>{try{const t=localStorage.getItem('navfolio-theme');document.documentElement.dataset.theme=t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'}catch{}})()</script>
    <style nonce="${input.nonce}">
      @font-face{font-family:"Maple Mono";src:url('/studio/login-assets/maple-mono.woff2') format('woff2');font-style:normal;font-weight:400 700;font-display:swap}
      @font-face{font-family:"Studio CN";src:url('/studio/login-assets/studio-cn.woff2') format('woff2');font-style:normal;font-weight:400;font-display:swap}
      :root{--paper-bg:#fdfdf9;--paper-bg-deep:#f3f5ef;--paper-surface:#fffffc;--paper-surface-muted:#f7f8f3;--paper-line:rgba(31,35,40,.075);--paper-line-strong:rgba(31,35,40,.12);--paper-ink:#272d28;--paper-ink-soft:#667066;--paper-ink-faint:#90998f;--paper-control:rgba(246,248,245,.76);--paper-control-hover:rgba(238,243,237,.92);--paper-accent:#637da3;--paper-accent-soft:#edf2f8;--accent-dark:#405b80;--paper-rule:rgba(63,88,125,.045);--paper-shadow-lift:0 1px 2px rgba(31,35,40,.04),0 18px 48px rgba(31,35,40,.07);--danger:#b84b4b;--danger-bg:rgba(184,75,75,.08);--font-body:"Maple Mono","Studio CN","PingFang SC","Microsoft YaHei",ui-monospace,monospace;--font-page-heading:"Studio CN","Maple Mono","PingFang SC","Microsoft YaHei",sans-serif;color-scheme:light}
      :root[data-theme='dark']{--paper-bg:#171b18;--paper-bg-deep:#111411;--paper-surface:#202620;--paper-surface-muted:#273026;--paper-line:rgba(217,229,213,.08);--paper-line-strong:rgba(217,229,213,.14);--paper-ink:#eaebe5;--paper-ink-soft:#b5beb1;--paper-ink-faint:#899487;--paper-control:rgba(42,51,43,.72);--paper-control-hover:rgba(52,64,53,.88);--paper-accent:#a8bddb;--paper-accent-soft:#29364a;--accent-dark:#d2e1f6;--paper-rule:rgba(204,222,246,.042);--paper-shadow-lift:0 1px 2px rgba(0,0,0,.16),0 18px 48px rgba(0,0,0,.2);--danger:#ef9999;--danger-bg:rgba(210,77,77,.13);color-scheme:dark}
      *{box-sizing:border-box}
      html{min-width:320px;background:var(--paper-bg)}
      body{min-height:100svh;margin:0;background-color:var(--paper-bg);background-image:linear-gradient(to bottom,transparent 31px,var(--paper-rule) 32px);background-size:100% 32px;color:var(--paper-ink);font:400 16px/1.6 var(--font-body);transition:background-color 180ms ease,color 180ms ease}
      button,input{font:inherit}
      a{color:inherit}
      .page{display:grid;width:min(1168px,calc(100% - 64px));min-height:100svh;margin:0 auto;grid-template-rows:auto 1fr auto}
      .masthead{display:flex;min-height:92px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--paper-line)}
      .brand{display:inline-flex;align-items:center;gap:11px;text-decoration:none}
      .brand-mark{display:grid;width:36px;height:36px;place-items:center;border-radius:10px;background:var(--paper-ink);color:var(--paper-bg);font-size:.7rem;font-weight:700;letter-spacing:.05em}
      .brand strong{font-size:.84rem;letter-spacing:.04em}
      .masthead-actions{display:flex;align-items:center;gap:8px}
      .theme-toggle,.public-link{display:inline-grid;min-width:44px;height:44px;place-items:center;border:1px solid var(--paper-line-strong);border-radius:9px;background:var(--paper-control);color:var(--paper-ink);text-decoration:none;cursor:pointer;transition:background 180ms ease,border-color 180ms ease,color 180ms ease}
      .public-link{display:inline-flex;padding:0 14px;font-size:.75rem;font-weight:600}
      .theme-toggle:hover,.public-link:hover{border-color:var(--paper-accent);background:var(--paper-control-hover);color:var(--paper-accent)}
      .theme-toggle svg{grid-area:1/1;width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;transition:opacity 180ms ease,transform 220ms ease}
      .icon-sun{opacity:0;transform:rotate(-14deg) scale(.82)}
      :root[data-theme='dark'] .icon-moon{opacity:0;transform:rotate(14deg) scale(.82)}
      :root[data-theme='dark'] .icon-sun{opacity:1;transform:none}
      .main{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,420px);gap:clamp(56px,8vw,112px);align-items:center;padding:64px 0 72px}
      .eyebrow,.workspace-note{margin:0;color:var(--paper-accent);font-size:.7rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase}
      .intro h1{max-width:560px;margin:18px 0 20px;font:400 clamp(2.55rem,5vw,4.1rem)/1.08 var(--font-page-heading);letter-spacing:-.035em}
      .intro-copy{max-width:500px;margin:0;color:var(--paper-ink-soft);font-size:1rem;line-height:1.9}
      .workspace-note{display:flex;align-items:center;gap:12px;margin-top:56px;color:var(--paper-ink-faint)}
      .workspace-note span{display:grid;width:30px;height:30px;place-items:center;border:1px solid var(--paper-line-strong);border-radius:50%;color:var(--paper-accent);font-size:.68rem}
      .login-card{padding:32px;border:1px solid var(--paper-line-strong);border-radius:14px;background:var(--paper-surface);box-shadow:var(--paper-shadow-lift);animation:card-in 420ms ease-out both}
      .card-kicker{margin:0 0 7px;color:var(--paper-accent);font-size:.68rem;font-weight:700;letter-spacing:.13em}
      .login-card h2{margin:0;font:600 1.28rem/1.35 var(--font-page-heading)}
      .card-description{margin:8px 0 24px;color:var(--paper-ink-soft);font-size:.82rem}
      .login-alert{display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start;margin:0 0 20px;padding:11px 12px;border:1px solid color-mix(in srgb,var(--danger) 52%,var(--paper-line));border-radius:9px;background:var(--danger-bg);color:var(--danger)}
      .login-alert span{display:grid;width:21px;height:21px;place-items:center;border:1px solid currentColor;border-radius:50%;font-size:.7rem;font-weight:700}
      .login-alert p{margin:0;font-size:.78rem;line-height:1.5}
      form{display:grid;gap:18px}
      .field{display:grid;gap:7px}
      .field-label{color:var(--paper-ink-soft);font-size:.74rem;font-weight:600}
      .input-wrap{position:relative}
      input{width:100%;height:48px;padding:0 14px;border:1px solid color-mix(in srgb,var(--paper-ink) 30%,var(--paper-bg));border-radius:9px;outline:0;background:var(--paper-surface-muted);color:var(--paper-ink);font-size:16px;transition:border-color 180ms ease,box-shadow 180ms ease,background 180ms ease}
      input:hover{border-color:var(--paper-line-strong);background:var(--paper-control-hover)}
      input:focus{border-color:var(--paper-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--paper-accent) 20%,transparent)}
      input:-webkit-autofill{-webkit-text-fill-color:var(--paper-ink);box-shadow:0 0 0 1000px var(--paper-surface-muted) inset;caret-color:var(--paper-ink)}
      .password-input{padding-right:68px}
      .reveal{position:absolute;top:2px;right:2px;display:grid;min-width:58px;height:44px;place-items:center;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--paper-ink-soft);font-size:.72rem;font-weight:600;cursor:pointer}
      .reveal:hover{background:var(--paper-control);color:var(--paper-accent)}
      .submit{display:grid;width:100%;height:48px;margin-top:4px;place-items:center;border:1px solid var(--accent-dark);border-radius:9px;background:var(--accent-dark);color:var(--paper-bg);font-size:.82rem;font-weight:700;cursor:pointer;transition:background 180ms ease,border-color 180ms ease,opacity 180ms ease,transform 120ms ease}
      :root[data-theme='dark'] .submit{color:#171b18}
      .submit:hover{border-color:var(--paper-accent);background:var(--paper-accent)}
      .submit:active{transform:scale(.985)}
      .submit:disabled{cursor:wait;opacity:.7}
      .security-note{display:flex;align-items:center;justify-content:center;gap:7px;margin:2px 0 0;color:var(--paper-ink-faint);font-size:.7rem}
      .security-note svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8}
      :focus-visible{outline:2px solid var(--paper-accent);outline-offset:3px}
      input:focus-visible{outline:0}
      .footer{display:flex;min-height:60px;align-items:center;justify-content:space-between;border-top:1px solid var(--paper-line);color:var(--paper-ink-faint);font-size:.67rem;letter-spacing:.08em}
      .status{display:flex;align-items:center;gap:8px}
      .status::before{width:6px;height:6px;border-radius:50%;background:var(--paper-accent);content:'';box-shadow:0 0 0 3px var(--paper-accent-soft)}
      @keyframes card-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
      @media(max-width:760px){.page{width:calc(100% - 32px)}.masthead{min-height:72px}.public-link{font-size:0;width:44px;padding:0}.public-link::after{content:'↗';font-size:1rem}.main{grid-template-columns:1fr;gap:36px;align-items:start;padding:40px 0 32px}.intro h1{margin:14px 0 14px;font-size:clamp(2.25rem,11vw,3.1rem)}.intro-copy{font-size:.92rem}.workspace-note{display:none}.login-card{width:100%;max-width:none;padding:24px}.footer{min-height:52px}.footer span:last-child{display:none}}
      @media(max-width:420px){.brand strong{display:none}.login-card{padding:20px}.main{padding-top:32px}}
      @media(prefers-reduced-motion:reduce),(forced-colors:active){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}.login-card{box-shadow:none}}
    </style>
  </head>
  <body>
    <div class="page">
      <header class="masthead">
        <a class="brand" href="/" aria-label="Gou Min 创作中心">
          <span class="brand-mark" aria-hidden="true">GM</span><strong>创作中心</strong>
        </a>
        <div class="masthead-actions">
          <button class="theme-toggle" type="button" data-theme-toggle aria-label="切换明暗主题" title="切换明暗主题">
            <svg class="icon-moon" aria-hidden="true" viewBox="0 0 24 24"><path d="M20.7 13.1A8.5 8.5 0 1 1 10.9 3.3 6.6 6.6 0 0 0 20.7 13.1Z"/></svg>
            <svg class="icon-sun" aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          </button>
          <a class="public-link" href="https://goumin.work/">返回网站&nbsp; ↗</a>
        </div>
      </header>
      <main class="main">
        <section class="intro" aria-labelledby="welcome-title">
          <p class="eyebrow">GOU MIN / PRIVATE STUDIO</p>
          <h1 id="welcome-title">回来继续创作。</h1>
          <p class="intro-copy">管理文章、项目与站点内容，把每一次记录稳稳地留在自己的空间里。</p>
          <p class="workspace-note"><span>01</span> AUTHORIZED WORKSPACE</p>
        </section>
        <section class="login-card" aria-labelledby="login-title">
          <p class="card-kicker">IDENTITY CHECK</p>
          <h2 id="login-title">登录创作中心</h2>
          <p class="card-description">使用后台账号继续进入你的工作台。</p>
          ${errorMarkup}
          <form method="post" action="${SESSION_PATH}" data-login-form>
            <input type="hidden" name="next" value="${nextPath}">
            <label class="field">
              <span class="field-label">用户名</span>
              <input name="username" value="${username}" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="80">
            </label>
            <label class="field">
              <span class="field-label">密码</span>
              <span class="input-wrap">
                <input class="password-input" type="password" name="password" autocomplete="current-password" required maxlength="512" autofocus data-password>
                <button class="reveal" type="button" aria-label="显示密码" aria-pressed="false" data-password-toggle>显示</button>
              </span>
            </label>
            <button class="submit" type="submit" data-submit><span>进入创作中心</span></button>
            <p class="security-note"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>仅限授权访问 · 会话将在 12 小时后失效</p>
          </form>
        </section>
      </main>
      <footer class="footer"><span class="status">STUDIO GATEWAY ONLINE</span><span>PRIVATE / NO INDEX</span></footer>
    </div>
    <script nonce="${input.nonce}">
      (()=>{const root=document.documentElement;const meta=document.querySelector('meta[name="theme-color"]');const apply=theme=>{const next=theme==='dark'?'dark':'light';root.dataset.theme=next;root.style.colorScheme=next;meta?.setAttribute('content',next==='dark'?'#171b18':'#fdfdf9');try{localStorage.setItem('navfolio-theme',next)}catch{};const button=document.querySelector('[data-theme-toggle]');const label=next==='dark'?'切换到浅色主题':'切换到深色主题';button?.setAttribute('aria-label',label);button?.setAttribute('title',label)};document.querySelector('[data-theme-toggle]')?.addEventListener('click',()=>apply(root.dataset.theme==='dark'?'light':'dark'));const password=document.querySelector('[data-password]');const toggle=document.querySelector('[data-password-toggle]');toggle?.addEventListener('click',()=>{if(!(password instanceof HTMLInputElement))return;const show=password.type==='password';password.type=show?'text':'password';toggle.textContent=show?'隐藏':'显示';toggle.setAttribute('aria-label',show?'隐藏密码':'显示密码');toggle.setAttribute('aria-pressed',String(show));password.focus()});const form=document.querySelector('[data-login-form]');form?.addEventListener('submit',()=>{form.setAttribute('aria-busy','true');for(const input of form.querySelectorAll('input:not([type="hidden"])') )input.readOnly=true;const submit=form.querySelector('[data-submit]');if(submit instanceof HTMLButtonElement){submit.disabled=true;submit.firstElementChild.textContent='正在验证…'}});apply(root.dataset.theme||'light')})();
    </script>
  </body>
</html>`;
}

function redirect(location: string, headers = new Headers()) {
  headers.set('Location', location);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(null, { headers, status: 303 });
}

function errorFromUrl(url: URL): LoginError | null {
  const error = url.searchParams.get('error');
  return error === 'credentials' || error === 'rate' || error === 'session' ? error : null;
}

function clientKey(request: Request) {
  const rawAddress =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';
  return isIP(rawAddress) ? rawAddress.toLowerCase() : 'unknown';
}

async function readLimitedFormBody(request: Request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > STUDIO_AUTH_MAX_REQUEST_BODY_SIZE) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(body);
}

function forwardedRequestDetails(request: Request) {
  const method = request.headers.get('x-forwarded-method') || request.method;
  const rawUri = request.headers.get('x-forwarded-uri') || '/studio';
  let url: URL;
  try {
    url = new URL(rawUri, 'https://studio.goumin.work');
  } catch {
    url = new URL('/studio', 'https://studio.goumin.work');
  }
  return { method: method.toUpperCase(), url };
}

function unauthorizedVerificationResponse(request: Request, hasSessionCookie: boolean) {
  const original = forwardedRequestDetails(request);
  const isDocumentRequest =
    original.method === 'GET' &&
    (request.headers.get('sec-fetch-dest') === 'document' ||
      request.headers.get('accept')?.includes('text/html'));
  if (!isDocumentRequest) {
    return new Response(
      JSON.stringify({ error: '登录状态已过期，请重新验证。', loginUrl: LOGIN_PATH }),
      {
        headers: new Headers({
          ...Object.fromEntries(securityHeaders()),
          'Content-Type': 'application/json; charset=utf-8',
        }),
        status: 401,
      },
    );
  }
  const nextPath = normalizeStudioNextPath(`${original.url.pathname}${original.url.search}`);
  const error = hasSessionCookie ? '&error=session' : '';
  return redirect(`${LOGIN_PATH}?next=${encodeURIComponent(nextPath)}${error}`, securityHeaders());
}

export function createStudioAuthService(options: StudioGatewayOptions) {
  const publicHost = (options.publicHost ?? 'studio.goumin.work').toLowerCase();
  const now = options.now ?? Date.now;
  const randomBytes =
    options.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const sessionTtlSeconds = options.sessionTtlSeconds ?? STUDIO_SESSION_TTL_SECONDS;
  const failures = new Map<string, FailureState>();

  const loginResponse = (url: URL) => {
    const contentNonce = nonce(randomBytes);
    const headers = securityHeaders(contentNonce);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    const error = errorFromUrl(url);
    if (error === 'rate') headers.set('Retry-After', '900');
    return new Response(
      renderStudioLoginPage({
        error,
        nextPath: normalizeStudioNextPath(url.searchParams.get('next')),
        nonce: contentNonce,
      }),
      { headers, status: error === 'rate' ? 429 : 200 },
    );
  };

  return async (request: Request) => {
    if (!isAllowedHost(request, publicHost)) {
      return privateTextResponse('Misdirected Request', 421);
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: {
          'Cache-Control': 'public, max-age=3600',
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }
    if (request.method === 'GET' && url.pathname === LOGIN_PATH) return loginResponse(url);

    if (request.method === 'GET' && url.pathname === '/internal/studio-auth/health') {
      return new Response(null, { status: 204 });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/studio/login-assets/')) {
      const asset = options.loginAssets?.[url.pathname];
      if (!asset) return privateTextResponse('Not Found', 404);
      return new Response(asset.body, {
        headers: {
          'Cache-Control': 'private, max-age=3600',
          'CDN-Cache-Control': 'no-store',
          'Content-Type': asset.contentType,
          'X-Content-Type-Options': 'nosniff',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
      });
    }

    if (request.method === 'POST' && url.pathname === SESSION_PATH) {
      if (!isAllowedFormOrigin(request, publicHost)) return privateTextResponse('Forbidden', 403);
      if (
        request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/x-www-form-urlencoded'
      ) {
        return privateTextResponse('Unsupported Media Type', 415);
      }
      if (Number(request.headers.get('content-length') || 0) > STUDIO_AUTH_MAX_REQUEST_BODY_SIZE) {
        return privateTextResponse('Payload Too Large', 413);
      }

      const key = clientKey(request);
      const currentTime = now();
      if (failures.size >= 1_024 && !failures.has(key)) {
        for (const [candidate, candidateState] of failures) {
          if (candidateState.resetAt <= currentTime) failures.delete(candidate);
        }
        while (failures.size >= 1_024) {
          const oldest = failures.keys().next().value;
          if (!oldest) break;
          failures.delete(oldest);
        }
      }
      const previous = failures.get(key);
      const state = previous && previous.resetAt > currentTime ? previous : undefined;
      if (state && state.failures >= MAX_FAILURES) {
        const headers = securityHeaders();
        headers.set(
          'Retry-After',
          String(Math.max(1, Math.ceil((state.resetAt - currentTime) / 1_000))),
        );
        return redirect(`${LOGIN_PATH}?error=rate`, headers);
      }

      const formBody = await readLimitedFormBody(request);
      if (formBody === null) return privateTextResponse('Payload Too Large', 413);
      const form = new URLSearchParams(formBody);
      const nextPath = normalizeStudioNextPath(form.get('next'));
      const valid = await verifyStudioCredentials({
        expectedPassword: options.password,
        expectedUsername: options.username,
        password: form.get('password') ?? '',
        username: form.get('username') ?? '',
      });
      if (!valid) {
        failures.set(key, {
          failures: (state?.failures ?? 0) + 1,
          resetAt: state?.resetAt ?? currentTime + FAILURE_WINDOW_MS,
        });
        return redirect(
          `${LOGIN_PATH}?error=credentials&next=${encodeURIComponent(nextPath)}`,
          securityHeaders(),
        );
      }

      failures.delete(key);
      const token = await createStudioSessionToken({
        nonce: randomBytes(18),
        now: currentTime,
        secret: options.sessionSecret,
        ttlSeconds: sessionTtlSeconds,
      });
      const headers = securityHeaders();
      headers.append(
        'Set-Cookie',
        `${STUDIO_SESSION_COOKIE}=${token}; Path=/; Max-Age=${sessionTtlSeconds}; HttpOnly; Secure; SameSite=Strict`,
      );
      return redirect(nextPath, headers);
    }

    if (request.method === 'POST' && url.pathname === LOGOUT_PATH) {
      if (!isAllowedFormOrigin(request, publicHost)) return privateTextResponse('Forbidden', 403);
      const headers = securityHeaders();
      headers.append(
        'Set-Cookie',
        `${STUDIO_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      );
      return redirect(LOGIN_PATH, headers);
    }

    if (request.method !== 'GET' || url.pathname !== VERIFY_PATH) {
      return privateTextResponse('Not Found', 404);
    }

    const token = parseCookies(request.headers.get('cookie')).get(STUDIO_SESSION_COOKIE);
    const authenticated = await verifyStudioSessionToken({
      now: now(),
      secret: options.sessionSecret,
      token,
    });
    if (!authenticated) {
      return unauthorizedVerificationResponse(request, Boolean(token));
    }
    const original = forwardedRequestDetails(request);
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(original.method) &&
      !isAllowedFormOrigin(request, publicHost)
    ) {
      return privateTextResponse('Forbidden', 403);
    }
    return new Response(null, { headers: securityHeaders(), status: 204 });
  };
}
