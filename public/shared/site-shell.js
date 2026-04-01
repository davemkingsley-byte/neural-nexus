(function () {
  const body = document.body;
  if (!body) return;

  const mode = body.dataset.siteShellMode || 'full';
  const active = body.dataset.siteShellActive || '';
  const backHref = body.dataset.siteShellBackHref || '/';
  const backLabel = body.dataset.siteShellBackLabel || '← Back to Neural NeXus';
  const footerTagline = body.dataset.siteShellFooterTagline || 'Signal over noise on AI, biotech, robotics, semiconductors, and the future.';
  const hideOnPrint = body.dataset.siteShellPrintHidden === 'true';

  if (!document.getElementById('nn-site-shell-styles')) {
    const style = document.createElement('style');
    style.id = 'nn-site-shell-styles';
    style.textContent = `
      body.nn-site-shell-ready {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }
      .nn-site-shell-header,
      .nn-site-shell-footer {
        width: min(1200px, calc(100vw - 32px));
        margin: 0 auto;
      }
      .nn-site-shell-header {
        position: relative;
        z-index: 20;
        margin-top: 16px;
        margin-bottom: 12px;
      }
      .nn-site-shell-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 14px 18px;
        border-radius: 18px;
        background: rgba(8, 10, 18, 0.82);
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 18px 44px rgba(0,0,0,0.24);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
      }
      .nn-site-shell-brand {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        color: #f5f5f7;
        text-decoration: none;
        font: 600 0.98rem/1.1 'DM Sans', system-ui, sans-serif;
        letter-spacing: -0.01em;
      }
      .nn-site-shell-brand img {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        object-fit: cover;
      }
      .nn-site-shell-brand span span { color: #d4a853; }
      .nn-site-shell-links {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .nn-site-shell-links a,
      .nn-site-shell-back {
        color: rgba(255,255,255,0.72);
        text-decoration: none;
        font: 500 0.92rem/1.2 'DM Sans', system-ui, sans-serif;
        padding: 8px 12px;
        border-radius: 999px;
        transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
        border: 1px solid transparent;
      }
      .nn-site-shell-links a:hover,
      .nn-site-shell-back:hover {
        color: #fff;
        background: rgba(255,255,255,0.06);
        border-color: rgba(255,255,255,0.08);
      }
      .nn-site-shell-links a.active {
        color: #d4a853;
        background: rgba(212,168,83,0.10);
        border-color: rgba(212,168,83,0.24);
      }
      .nn-site-shell-back {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .nn-site-shell-footer {
        margin-top: auto;
        padding: 28px 0 24px;
      }
      .nn-site-shell-footer-card {
        background: rgba(8, 10, 18, 0.72);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 24px;
        padding: 22px 24px;
        box-shadow: 0 18px 44px rgba(0,0,0,0.18);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
      }
      .nn-site-shell-footer-top {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: flex-start;
      }
      .nn-site-shell-footer-copy {
        max-width: 420px;
      }
      .nn-site-shell-footer-copy p {
        margin-top: 10px;
        color: rgba(255,255,255,0.62);
        font: 400 0.92rem/1.55 'DM Sans', system-ui, sans-serif;
      }
      .nn-site-shell-footer-links {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 10px;
      }
      .nn-site-shell-footer-links a {
        color: rgba(255,255,255,0.7);
        text-decoration: none;
        font: 500 0.9rem/1.2 'DM Sans', system-ui, sans-serif;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
      }
      .nn-site-shell-footer-links a:hover {
        color: #fff;
        border-color: rgba(212,168,83,0.28);
        background: rgba(212,168,83,0.08);
      }
      .nn-site-shell-footer-bottom {
        margin-top: 16px;
        padding-top: 14px;
        border-top: 1px solid rgba(255,255,255,0.08);
        color: rgba(255,255,255,0.46);
        font: 400 0.82rem/1.4 'DM Sans', system-ui, sans-serif;
      }
      body[data-site-shell-mode="back"] .page,
      body[data-site-shell-mode="back"] .shell,
      body[data-site-shell-mode="back"] .container {
        margin-top: 0;
      }
      @media (max-width: 720px) {
        .nn-site-shell-card,
        .nn-site-shell-footer-top {
          flex-direction: column;
          align-items: flex-start;
        }
        .nn-site-shell-links,
        .nn-site-shell-footer-links {
          justify-content: flex-start;
        }
      }
      @media print {
        body[data-site-shell-print-hidden="true"] .nn-site-shell-header,
        body[data-site-shell-print-hidden="true"] .nn-site-shell-footer {
          display: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  const header = document.createElement('div');
  header.className = 'nn-site-shell-header';

  const brandHtml = `
    <a href="/" class="nn-site-shell-brand" aria-label="Neural NeXus home">
      <img src="/img/neuron-logo.jpg" alt="Neural NeXus">
      <span>Neural<span>NeXus</span></span>
    </a>
  `;

  const navLinks = [
    { href: '/', label: 'Home', key: 'home' },
    { href: '/topics/ai', label: 'Topics', key: 'topics' },
    { href: '/archive', label: 'Archive', key: 'archive' },
    { href: '/play', label: 'Games', key: 'games' },
    { href: '/cognitive/', label: 'Cognitive', key: 'cognitive' }
  ];

  if (mode === 'back') {
    header.innerHTML = `
      <div class="nn-site-shell-card">
        ${brandHtml}
        <a href="${backHref}" class="nn-site-shell-back">${backLabel}</a>
      </div>
    `;
  } else {
    const linksHtml = navLinks
      .map(link => `<a href="${link.href}" class="${active === link.key ? 'active' : ''}">${link.label}</a>`)
      .join('');

    header.innerHTML = `
      <div class="nn-site-shell-card">
        ${brandHtml}
        <div class="nn-site-shell-links">${linksHtml}</div>
      </div>
    `;
  }

  body.insertBefore(header, body.firstChild);

  const footer = document.createElement('footer');
  footer.className = 'nn-site-shell-footer';
  footer.innerHTML = `
    <div class="nn-site-shell-footer-card">
      <div class="nn-site-shell-footer-top">
        <div class="nn-site-shell-footer-copy">
          ${brandHtml}
          <p>${footerTagline}</p>
        </div>
        <div class="nn-site-shell-footer-links">
          <a href="/">Home</a>
          <a href="/topics/ai">Topics</a>
          <a href="/archive">Archive</a>
          <a href="/play">Games</a>
          <a href="/privacy">Privacy</a>
        </div>
      </div>
      <div class="nn-site-shell-footer-bottom">© 2026 Neural NeXus. All rights reserved.</div>
    </div>
  `;

  body.appendChild(footer);
  body.classList.add('nn-site-shell-ready');

  if (hideOnPrint) {
    body.setAttribute('data-site-shell-print-hidden', 'true');
  }
})();
