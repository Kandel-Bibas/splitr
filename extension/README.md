# Splitr extension

Adds a "Send to Splitr" button on Walmart and Sam's Club order pages. It captures the order and opens it in a new Splitr tab at `/expenses/new/itemized?import=<token>`. The extension passes the capture to the page through a window message, so Splitr needs no inbound request (it sits behind Cloudflare Access).

## Load it

1. Open `chrome://extensions` and turn on Developer mode.
2. Choose Load unpacked and select this folder.

Disable the old "Order Split" extension, or both buttons appear on the order page.

## Which Splitr it opens

If a tab is open on `http://localhost:5173`, the order opens there (dev). Otherwise it opens `https://money.aditya24sharma.dev`. Captures are kept in session storage for up to an hour and handed out once.
