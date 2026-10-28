// Holds captures from content.js until the Splitr page claims them, and opens that page.
const SPLITR_DEV = 'http://localhost:5173';
const SPLITR_PROD = 'https://splitr.bibas.dev';
const SPLITR_ORIGINS = [SPLITR_DEV, SPLITR_PROD];
const SHOP_ORIGINS = ['https://www.walmart.com', 'https://www.samsclub.com'];
const KEY_PREFIX = 'capture:';
const MAX_AGE_MS = 60 * 60 * 1000;

const originOf = (url) => {
  try { return new URL(url).origin; } catch { return null; }
};

// Unclaimed captures (page never opened, or closed first) would otherwise fill the quota.
async function dropStale() {
  const all = await chrome.storage.session.get(null);
  const stale = Object.entries(all)
    .filter(([key, v]) => key.startsWith(KEY_PREFIX) && !(Date.now() - v?.savedAt < MAX_AGE_MS))
    .map(([key]) => key);
  if (stale.length) await chrome.storage.session.remove(stale);
}

// Prefer a dev server the user has open; otherwise production.
async function splitrOrigin() {
  for (const origin of SPLITR_ORIGINS) {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    if (tabs.length) return origin;
  }
  return SPLITR_PROD;
}

async function importCapture(body, senderTab) {
  if (typeof body !== 'string' || !body) return { ok: false, detail: 'the capture was empty' };
  try {
    await dropStale();
    const token = crypto.randomUUID();
    await chrome.storage.session.set({ [KEY_PREFIX + token]: { body, savedAt: Date.now() } });
    const origin = await splitrOrigin();
    // A new tab, never an existing one: it may hold unsaved work.
    await chrome.tabs.create({
      url: `${origin}/expenses/new/itemized?import=${token}`,
      windowId: senderTab.windowId,
      index: senderTab.index + 1,
      openerTabId: senderTab.id,
    });
    return { ok: true };
  } catch (e) {
    const detail = /quota/i.test(e.message)
      ? `the order is too large for the extension's temporary storage (${e.message})`
      : e.message;
    return { ok: false, detail };
  }
}

async function takeCapture(token) {
  if (typeof token !== 'string' || !token) return { found: false };
  const key = KEY_PREFIX + token;
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored) return { found: false };
  await chrome.storage.session.remove(key);
  return { found: true, body: stored.body };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const origin = originOf(sender.url);
  if (message?.type === 'import' && SHOP_ORIGINS.includes(origin) && sender.tab) {
    importCapture(message.body, sender.tab).then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (message?.type === 'take' && SPLITR_ORIGINS.includes(origin)) {
    takeCapture(message.token)
      .then(sendResponse)
      .catch((e) => sendResponse({ found: false, error: e.message }));
    return true;
  }
  return false;
});
