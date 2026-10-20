// Answers the Splitr page's window messages (see src/order-handoff.ts) with the
// capture held by background.js.
(() => {
  // The page re-asks every 250 ms until answered; handle each token once.
  const handled = new Set();

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.source !== 'splitr-page' || data.type !== 'take-capture') return;
    const token = data.token;
    if (typeof token !== 'string' || !token || handled.has(token)) return;
    handled.add(token);

    const reply = (message) => window.postMessage({ source: 'splitr-extension', token, ...message }, location.origin);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'take', token });
      if (result?.found) reply({ type: 'capture', capture: JSON.parse(result.body) });
      else if (result?.error) throw new Error(result.error);
      else reply({ type: 'capture-missing' });
    } catch (e) {
      // Unanswered, so the page's next retry may try again.
      handled.delete(token);
      console.error('Splitr: could not fetch the capture', e);
    }
  });
})();
