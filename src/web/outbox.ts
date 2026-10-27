/**
 * The outbox: what a person did while the network was away, kept in the
 * browser and sent when it is back. Safari has no Background Sync, so
 * nothing here waits for the browser to wake us: the page flushes when it
 * opens, on `online`, and after every add.
 *
 * Every entry carries its own Idempotency-Key, made once when the act is
 * queued. The server answers a repeated key with the first answer
 * (`core/idempotency.ts`), so a request that landed but whose answer was
 * lost is replayed without doing it twice. Entries leave the queue when the
 * server has decided: any 2xx, or a 4xx that retrying cannot fix. A network
 * failure, 5xx, 408, 429 or 401 stops the flush and keeps the rest, in order.
 *
 * Shipped to the page as source text (like the other client scripts) and
 * evaluated by the test, so the code that runs is the code that is tested.
 */

export const OUTBOX_KEY = "forge.outbox";
export const OUTBOX_MAX = 200;

export const outboxJs = /* js */ `
function forgeOutbox(storage, send, now) {
  var KEY = ${JSON.stringify(OUTBOX_KEY)};
  var MAX = ${OUTBOX_MAX};
  var flushing = null;
  function read() {
    try {
      var list = JSON.parse(storage.getItem(KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function write(list) {
    try { storage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
  }
  function makeKey() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function final(status) {
    if (status >= 200 && status < 300) return true;
    if (status >= 400 && status < 500) return status !== 401 && status !== 408 && status !== 429;
    return false;
  }
  function add(url, payload) {
    var list = read();
    list.push({ key: makeKey(), url: url, body: JSON.stringify(payload), at: (now || Date.now)() });
    write(list.slice(-MAX));
  }
  function run() {
    var list = read();
    if (list.length === 0) return Promise.resolve({ sent: 0, left: 0 });
    var sent = 0, refused = 0;
    function next() {
      var entry = read()[0];
      if (!entry) return Promise.resolve();
      return send(entry.url, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json', 'idempotency-key': entry.key },
        body: entry.body
      }).then(function (r) {
        if (!final(r.status)) return;
        write(read().filter(function (e) { return e.key !== entry.key; }));
        if (r.status < 300) sent++; else refused++;
        return next();
      }, function () {});
    }
    return next().then(function () { return { sent: sent, refused: refused, left: read().length }; });
  }
  // One flush at a time: two tabs of one page share storage, two flushes in
  // one page must not send an entry twice before the first has been dropped.
  function flush() {
    if (!flushing) flushing = run().then(function (r) { flushing = null; return r; }, function () { flushing = null; return { sent: 0, left: read().length }; });
    return flushing;
  }
  function clear() { try { storage.removeItem(KEY); } catch (e) {} }
  return { add: add, flush: flush, size: function () { return read().length; }, clear: clear };
}
`;
