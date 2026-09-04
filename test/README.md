# Tests

No build step and no dependencies in the extension itself — these run straight on
Node. `reader.test.mjs` needs jsdom, which is the only dev dependency:

```sh
npm install --no-save jsdom
node test/reader-store.test.mjs   # session persistence, LRU eviction
node test/reader.test.mjs         # loads reader.html in jsdom, drives the UI
```

`reader.test.mjs` fakes `chrome.storage`, `chrome.i18n` and the `kana-stream`
port, then exercises the reader the way a user does: annotate, cancel mid-run,
retry after an error, survive a dropped service worker, edit annotated text,
reload. The fake port is two-sided, so a test can push exactly the message
sequence the service worker would send.
