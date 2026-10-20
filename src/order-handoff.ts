// The page's half of the hand-off from the Splitr extension.
//
// On a Walmart or Sam's Club order page, "Send to Splitr" captures the order,
// the extension keeps it under a random token, and opens
// /expenses/new/itemized?import=<token>. That page asks for the capture with
// a window message; the extension's bridge script on this origin answers.
//
//   page   -> { source: 'splitr-page', type: 'take-capture', token }
//   bridge -> { source: 'splitr-extension', type: 'capture', token, capture }
//           | { source: 'splitr-extension', type: 'capture-missing', token }
//
// The bridge hands each capture out once and then deletes it.

export const PAGE_SOURCE = 'splitr-page'
export const EXTENSION_SOURCE = 'splitr-extension'

const RETRY_MS = 250
/** The bridge loads at document_idle, so the first requests can go unanswered. */
const GIVE_UP_MS = 5000

// One request per token: the bridge answers only once, and StrictMode runs
// the page's effect twice.
const requests = new Map<string, Promise<unknown>>()

/** The capture the extension holds under this token. */
export function takeCapture(token: string): Promise<unknown> {
  let request = requests.get(token)
  if (!request) {
    request = requestCapture(token)
    requests.set(token, request)
  }
  return request
}

function requestCapture(token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return
      const data = event.data as { source?: unknown; type?: unknown; token?: unknown; capture?: unknown } | null
      if (data?.source !== EXTENSION_SOURCE || data.token !== token) return
      if (data.type === 'capture') finish(() => resolve(data.capture))
      else if (data.type === 'capture-missing') {
        finish(() => reject(new Error('This order was already opened or has expired. Send it from the order page again.')))
      }
    }
    const ask = () => window.postMessage({ source: PAGE_SOURCE, type: 'take-capture', token }, location.origin)
    const retry = setInterval(ask, RETRY_MS)
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("The Splitr extension didn't answer. Check it's installed and enabled for this site.")))
    }, GIVE_UP_MS)
    const finish = (settle: () => void) => {
      clearInterval(retry)
      clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
      settle()
    }
    window.addEventListener('message', onMessage)
    ask()
  })
}
