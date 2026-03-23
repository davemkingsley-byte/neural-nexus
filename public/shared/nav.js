// Global Navigation Bar — inject into all pages
(function() {
  const NAV_ID = 'nn-global-nav';
  if (document.getElementById(NAV_ID)) return;

  const nav = document.createElement('nav');
  nav.id = NAV_ID;
  nav.innerHTML = `
    <div class="nn-nav-inner">
      <a href="/" class="nn-nav-logo">Neural NeXus</a>
      <div class="nn-nav-links">
        <a href="/cognitive/?key=nexus2026" data-path="/cognitive">Dashboard</a>
        <a href="/pm/?key=nexus2026" data-path="/pm">Projects</a>
        <a href="/app/?key=nexus2026" data-path="/app">App</a>
        <a href="/brain-check" data-path="/brain-check">Brain Check</a>
        <a href="/play" data-path="/play">Spelling Bee</a>
      </div>
      <button class="nn-nav-toggle" aria-label="Menu">☰</button>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #nn-global-nav {
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      background: rgba(6,6,11,0.95); backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      font-family: 'DM Sans', system-ui, sans-serif;
    }
    .nn-nav-inner {
      max-width: 1200px; margin: 0 auto;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 20px; height: 48px;
    }
    .nn-nav-logo {
      color: #c9a84c; font-weight: 700; font-size: 15px;
      text-decoration: none; letter-spacing: 0.5px;
    }
    .nn-nav-links { display: flex; gap: 4px; }
    .nn-nav-links a {
      color: rgba(255,255,255,0.5); text-decoration: none;
      font-size: 13px; font-weight: 500; padding: 6px 12px;
      border-radius: 6px; transition: all 0.2s;
    }
    .nn-nav-links a:hover { color: #fff; background: rgba(255,255,255,0.06); }
    .nn-nav-links a.active { color: #c9a84c; background: rgba(201,168,76,0.1); }
    .nn-nav-toggle {
      display: none; background: none; border: none;
      color: #fff; font-size: 20px; cursor: pointer; padding: 4px 8px;
    }
    @media (max-width: 640px) {
      .nn-nav-links { 
        display: none; position: absolute; top: 48px; left: 0; right: 0;
        flex-direction: column; background: rgba(6,6,11,0.98);
        border-bottom: 1px solid rgba(255,255,255,0.08);
        padding: 8px;
      }
      .nn-nav-links.open { display: flex; }
      .nn-nav-links a { padding: 10px 16px; font-size: 14px; }
      .nn-nav-toggle { display: block; }
    }
    body { padding-top: 48px !important; }
  `;

  document.head.appendChild(style);
  document.body.prepend(nav);

  // Highlight active page
  const path = window.location.pathname;
  nav.querySelectorAll('.nn-nav-links a').forEach(a => {
    const dp = a.getAttribute('data-path');
    if (dp && path.startsWith(dp)) a.classList.add('active');
  });

  // Mobile toggle
  nav.querySelector('.nn-nav-toggle').addEventListener('click', () => {
    nav.querySelector('.nn-nav-links').classList.toggle('open');
  });
})();
