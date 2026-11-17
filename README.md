# CapitalOne Offers Loader

Loads the offers from the CapitalOne Offers feed (`https://capitaloneoffers.com/feed`) and lets you search, filter and sort them.

## Filters
Reward type chips, Availability and Merchant all accept several selections at once. Choices within one filter are OR'd (% back or Bonus miles), different filters are AND'd. **Min reward value** compares the first number in the reward text (5 in "Up to 5% back", 9 in "9X miles"), so pair it with a reward type chip when you do not want to mix units. **One offer per merchant** keeps only the first matching offer for each merchant.

## Install
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Select **Load unpacked** and choose this folder.
3. Open https://capitaloneoffers.com/feed while signed in. An **Offers explorer** button appears at the bottom right.

## How it works
- Requests the same `GET /feed/<card>` pages the site requests, following `cursor` for up to **Max pages** (default 50).
- **View offer** opens the offer's own `redirectUrl` when the feed provides one. Otherwise it opens the offer's detail page on the site, using the site's own offer id (or the same id format the site builds). If neither is possible it presses the site's own tile for that merchant.
- Results are cached for 60 minutes per card, since the links can be signed by the site. Switching cards on the site loads that card's offers separately.
- Settings (Max pages, Delay, Cache) are saved in the page's `localStorage`.
- Only shown on the feed (`/feed`), not on an offer's detail page.

## Why it runs in the page's own context
The extension uses `"world": "MAIN"` so it can read the site's session state (card id and view details) and notice when you switch credit cards. That world has no `chrome.storage`, which is why `localStorage` is used instead.