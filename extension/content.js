// Adds a "Send to Splitr" button on walmart.com / samsclub.com order pages.
// Builds the capture and hands it to background.js, which opens it in Splitr.
(() => {
  const ORDER_PATH = /^\/(?:en\/)?orders\/(\d+)\/?$/;
  const SITE = location.hostname === 'www.samsclub.com' ? 'samsclub' : 'walmart';

  const orderId = () => (location.pathname.match(ORDER_PATH) || [])[1] || null;

  const nextDataFrom = (doc) => {
    const el = doc.querySelector('script#__NEXT_DATA__');
    try { return el ? JSON.parse(el.textContent) : null; } catch { return null; }
  };

  const dump = (html, nextData) => ({
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    html,
    jsonScripts: nextData ? [{ id: '__NEXT_DATA__', type: 'application/json', parsed: nextData, rawLength: 0 }] : [],
    windowState: {},
    networkUrls: [],
  });

  // Walmart embeds the order in __NEXT_DATA__ only on a full page load. After in-app
  // navigation the page still holds the previous page's data, so fetch the order page's
  // server-rendered HTML with the user's session instead of asking them to reload.
  async function walmartCapture(id) {
    const holdsOrder = (nd) => nd && nd.page === '/orders/[orderId]' &&
      nd.props?.pageProps?.initialData?.data?.order?.id === id;

    const current = nextDataFrom(document);
    if (holdsOrder(current)) return dump(document.documentElement.outerHTML, current);

    const res = await fetch(location.href, { credentials: 'include' });
    if (!res.ok) throw new Error(`walmart.com answered ${res.status} when re-fetching this order`);
    const html = await res.text();
    const fetched = nextDataFrom(new DOMParser().parseFromString(html, 'text/html'));
    if (!holdsOrder(fetched)) {
      throw new Error("walmart.com didn't return this order's data. Reload the page and try again.");
    }
    return dump(html, fetched);
  }

  // Sam's loads the order client-side; wait until the DOM shows this order's items.
  async function samsCapture(id) {
    const ready = () => document.querySelector(`[id^="caption-${id}-"]`) &&
      document.querySelector('[data-testid="itemtile-stack"]') &&
      document.body.innerText.includes('Subtotal');
    for (let waited = 0; !ready(); waited += 250) {
      if (waited > 15000) throw new Error("The order page hasn't finished loading its items.");
      await new Promise((r) => setTimeout(r, 250));
    }
    return dump(document.documentElement.outerHTML, nextDataFrom(document));
  }

  // --- button ---------------------------------------------------------------------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;display:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      .card { font: 14px/1.45 "Inter","Helvetica Neue",ui-sans-serif,system-ui,sans-serif; font-weight: 400;
              background: light-dark(#ffffff,#1a1919); color: light-dark(#0c0a08,#f4f2f0);
              border: 1px solid light-dark(#d3d3d3,#474543); border-radius: 12px; padding: 12px;
              display: flex; flex-direction: column; gap: 8px; max-width: 280px; }
      button { font: inherit; height: 44px; padding: 0 20px; border: 0; border-radius: 6px; cursor: pointer;
               background: #e4f222; color: #0c0a08; transition: background .3s ease-out, color .3s ease-out; }
      button:hover { background: light-dark(#0c0a08,#f4f2f0); color: light-dark(#ffffff,#0c0a08); }
      button:disabled { cursor: progress; opacity: .7; }
      button:focus-visible { outline: 2px solid light-dark(#0c0a08,#f4f2f0); outline-offset: 2px; }
      .msg { margin: 0; color: light-dark(#3b3937,#c9c6c2); }
      .msg.bad { color: light-dark(#a32018,#ff8f85); }
      .msg:empty { display: none; }
    </style>
    <div class="card">
      <button type="button">Send to Splitr</button>
      <p class="msg" role="status"></p>
    </div>`;
  const button = root.querySelector('button');
  const msg = root.querySelector('.msg');
  document.documentElement.appendChild(host);

  const say = (text, bad = false) => { msg.textContent = text; msg.className = bad ? 'msg bad' : 'msg'; };

  button.addEventListener('click', async () => {
    const id = orderId();
    if (!id) return;
    button.disabled = true;
    say('Capturing…');
    try {
      const capture = SITE === 'samsclub' ? await samsCapture(id) : await walmartCapture(id);
      say('Sending…');
      const reply = await chrome.runtime.sendMessage({ type: 'import', body: JSON.stringify(capture) });
      if (reply.ok) say('Opened in Splitr.');
      else say(`Problem: ${reply.detail}`, true);
    } catch (e) {
      say(`Problem: ${e.message}`, true);
    } finally {
      button.disabled = false;
    }
  });

  // walmart.com / samsclub.com navigate client-side, so follow URL changes.
  let lastPath = null;
  const sync = () => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    host.style.display = orderId() ? 'block' : 'none';
    say('');
  };
  sync();
  setInterval(sync, 700);
})();
