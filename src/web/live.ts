/**
 * The live-updates client: a small, framework-free EventSource consumer. It
 * reads its configuration from a `#live` element's data attributes (never from
 * interpolated script text — the CSP forbids that anyway) and:
 *   - on a comment for the thread you're viewing, fetches the new comments and
 *     appends them, so a conversation updates as people type;
 *   - on any other relevant activity on a list page, fetches the page and
 *     merges new rows into the lists in place (never a refresh bar).
 * Every page works without this; it is pure enhancement.
 *
 * Announcements are a count, not the text: the polite live region says "2 new
 * comments" while the comments themselves land outside it, so a screen reader
 * is told something arrived without re-reading the thread. The app page's own
 * swap is the one exception — there is no count to give, so the region says
 * the same word and phrase the card itself just changed to ("live 6.1s after
 * the push"), read off the swapped-in markup rather than invented twice.
 */

import { html, type Html } from "./html.ts";

/** At most this many streams from one page: browsers cap connections. */
export const MAX_LIVE_STREAMS = 3;

export interface LiveConfig {
  /** Repo base path, e.g. "/alice/app". */
  repo: string;
  /**
   * More repositories to watch, for a page that is about several at once
   * (the dashboard's activity rail). There is no user-level stream yet, so a
   * page that spans repositories opens one connection per repository —
   * capped, because a browser will not hold many.
   */
  repos?: readonly string[];
  /** "issue" | "pull" for a thread page; omit on lists. */
  thread?: "issue" | "pull";
  /** The issue/PR number, for a thread page. */
  number?: number;
  /** Id of the last comment already on the page (for the ?after= fetch). */
  lastCommentId?: string;
  /**
   * The commit production serves once this change has shipped (its merge
   * commit, else its head), for a pull page: an `app.serving` for production
   * at exactly this commit swaps the check line and Preview card in place.
   */
  head?: string;
  /**
   * The studio app page: a deploy run event for this repo fetches
   * `<repo>/app/state` and swaps the head card and previews list in place,
   * rather than only announcing it.
   */
  app?: boolean;
}

/** The config element, the polite status line, the quiet "N above" marker and the connection word. */
export function liveMount(config: LiveConfig): Html {
  return html`<div
      id="live"
      hidden
      data-repo="${config.repo}"
      data-repos="${(config.repos ?? []).slice(0, MAX_LIVE_STREAMS).join(" ")}"
      data-thread="${config.thread ?? ""}"
      data-number="${config.number ?? ""}"
      data-last="${config.lastCommentId ?? ""}"
      data-head="${config.head ?? ""}"
      data-app="${config.app ? "1" : ""}"
    ></div>
    <p
      class="sr-only"
      id="live-status"
      role="status"
      aria-live="polite"
    ></p>
    <div class="live-news">
      <a id="live-above" class="badge" href="#top" hidden>new above</a>
      <span id="live-conn" class="badge" data-variant="attn" role="status" hidden
        >offline</span
      >
    </div>`;
}

export const liveClientJs = /* js */ `
(function () {
  var cfg = document.getElementById('live');
  if (!cfg || typeof EventSource === 'undefined') return;
  var repo = cfg.getAttribute('data-repo');
  var thread = cfg.getAttribute('data-thread');
  var number = cfg.getAttribute('data-number');
  var lastId = cfg.getAttribute('data-last') || '';
  var isApp = cfg.getAttribute('data-app') === '1';
  var head = cfg.getAttribute('data-head') || '';
  var marker = document.getElementById('live-above');
  var status = document.getElementById('live-status');
  // The polite status line: said when the page has one.
  function say(text) {
    if (!status) return;
    status.textContent = text;
  }
  // A page that cannot animate, or whose reader asks it not to, shows a new row at once.
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // New things arrive in place. An event on a list page schedules one catch-up
  // (a burst of events is one fetch, never sooner than BATCH after the first):
  // the page's own HTML is fetched, and every row it has that the list lacks is
  // inserted where the fresh order puts it; a row that changed is replaced in
  // place unless the reader is in it, and a row the page no longer lists is
  // removed unless the reader is in it. A reader at the top sees rows slide in;
  // anyone scrolled, typing or reading has the rows added above with the
  // scroll compensated by exactly their height, and a quiet "N above" marker
  // to jump up when they choose. Nothing asks for a refresh.
  var BATCH = 400;
  var DOWN_AFTER = 2000;
  var above = 0;
  function setAbove(n) {
    above = n;
    if (!marker) return;
    marker.hidden = n <= 0;
    if (n > 0) marker.textContent = n + ' above';
  }
  if (marker) marker.addEventListener('click', function (e) {
    e.preventDefault();
    window.scrollTo(0, 0);
    setAbove(0);
    var first = document.querySelector('ul.list > li a[href]');
    if (first) first.focus();
  });
  window.addEventListener('scroll', function () {
    if (above > 0 && (window.pageYOffset || 0) < 8) setAbove(0);
  }, { passive: true });

  function kids(list) {
    return Array.prototype.filter.call(list.children, function (n) { return n.tagName === 'LI'; });
  }
  function keyOf(li) {
    if (li.id) return '#' + li.id;
    var a = li.querySelector('a[href]');
    return a ? a.getAttribute('href') : '';
  }
  function sameRow(a, b) {
    var t = /<time\\b[^>]*>[^<]*<\\/time>/g;
    return a.replace(t, '') === b.replace(t, '');
  }
  // A row the reader is in is never replaced under them.
  function held(li) {
    var a = document.activeElement;
    if (a && li.contains(a) && a !== document.body) return true;
    if (li.querySelector('[data-busy], [data-live-hold]')) return true;
    return Array.prototype.some.call(li.querySelectorAll('input, textarea'), function (i) {
      return i.type !== 'hidden' && i.type !== 'checkbox' && i.value !== '';
    });
  }
  function typing() {
    var a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable === true);
  }
  // Whether a fetched list is only part of what the server has: the page
  // offers a pager link (ui.ts pager(), or a page's own nav.pager) or the
  // list ends in an "and N more" row ([data-more]).
  function offersMore(page, list) {
    return !!(page.querySelector('nav.pager a[href]') || list.querySelector('[data-more]'));
  }
  // Merges one fetched list into the one on screen. Returns how many rows
  // arrived (counted for the marker: only those above the reader when not
  // calm) and how many were removed.
  function mergeList(mine, theirs, calm, partial) {
    var olds = kids(mine);
    var have = {};
    olds.forEach(function (li) { var k = keyOf(li); if (k) have[k] = li; });
    // A row the server no longer lists (deleted, filtered out) goes, unless
    // the reader is in it. A complete page is the whole list, so every row
    // it lacks goes — the last, the only one, all of them. A page that offers
    // more is truncated: a row pushed off it, or loaded past it, is not gone,
    // so only rows before the last row it still lists are candidates.
    var listed = {};
    kids(theirs).forEach(function (n) { var k = keyOf(n); if (k) listed[k] = true; });
    var lastAt = partial ? -1 : olds.length;
    if (partial) olds.forEach(function (li, at) { var k = keyOf(li); if (k && listed[k]) lastAt = at; });
    var doomed = olds.filter(function (li, at) {
      var k = keyOf(li);
      return at < lastAt && k && !listed[k] && !held(li);
    });
    // The row the reader is looking at: it must stay where it is. Never one
    // that is about to be removed.
    var kept = olds.filter(function (li) { return doomed.indexOf(li) < 0; });
    var ref = null;
    for (var i = 0; i < kept.length; i++) {
      if (kept[i].getBoundingClientRect().bottom > 0) { ref = kept[i]; break; }
    }
    if (!ref) ref = kept[0] || null;
    var refTop = ref ? ref.getBoundingClientRect().top : 0;
    var prev = null, added = [];
    kids(theirs).forEach(function (n) {
      var k = keyOf(n);
      if (!k) return;
      var cur = have[k];
      if (cur) {
        if (!held(cur) && !sameRow(cur.innerHTML, n.innerHTML)) {
          var swapped = document.importNode(n, true);
          cur.replaceWith(swapped);
          if (cur === ref) ref = swapped;
          have[k] = swapped;
          cur = swapped;
        }
        prev = cur;
        return;
      }
      var fresh = document.importNode(n, true);
      if (prev) prev.after(fresh); else mine.insertBefore(fresh, mine.firstChild);
      have[k] = fresh;
      prev = fresh;
      added.push(fresh);
    });
    if (doomed.length > 0) {
      doomed.forEach(function (li) { delete have[keyOf(li)]; li.remove(); });
    }
    if (added.length > 0 || doomed.length > 0) {
      if (!calm && ref) {
        var shift = ref.getBoundingClientRect().top - refTop;
        if (shift !== 0) window.scrollBy(0, shift);
      }
    }
    var out = { added: 0, removed: doomed.length };
    if (added.length === 0) return out;
    if (calm) {
      added.forEach(function (n) {
        if (still) return;
        var done = function () { n.classList.remove('live-arrived'); };
        n.classList.add('live-arrived');
        n.addEventListener('animationend', done);
        setTimeout(done, 400);
      });
      out.added = added.length;
      return out;
    }
    var gone = ref ? 0 : added.length;
    if (ref) {
      added.forEach(function (n) { if (n.compareDocumentPosition(ref) & 4) gone++; });
    }
    out.added = gone;
    return out;
  }
  function mergePage(fresh) {
    var mine = document.querySelectorAll('ul.list');
    var theirs = fresh.querySelectorAll('ul.list');
    if (mine.length === 0 || mine.length !== theirs.length) return;
    var calm = (window.pageYOffset || 0) < 8 && !typing();
    var total = 0, removed = 0;
    for (var i = 0; i < mine.length; i++) {
      if (mine[i].closest('#app-previews, #app-head')) continue;
      var got = mergeList(mine[i], theirs[i], calm, offersMore(fresh, theirs[i]));
      total += got.added;
      removed += got.removed;
    }
    if (total === 0) {
      if (removed > 0) say(removed === 1 ? '1 item removed' : removed + ' items removed');
      return;
    }
    if (!calm) setAbove(above + total);
    say(total === 1 ? '1 new item' : total + ' new items');
  }
  var syncBusy = false, syncQueued = false, syncTimer = null;
  function schedule() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () { syncTimer = null; sync(); }, BATCH);
  }
  function sync() {
    if (syncBusy) { syncQueued = true; return; }
    syncBusy = true;
    fetch(location.pathname + location.search, { headers: { accept: 'text/html' }, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        if (!text) return;
        var holder = document.createElement('template');
        holder.innerHTML = text.replace(/<(style|script)[^>]*>[\\s\\S]*?<\\/\\1>/gi, '');
        mergePage(holder.content);
      })
      .catch(function () {})
      .then(function () {
        syncBusy = false;
        if (syncQueued) { syncQueued = false; schedule(); }
      });
  }
  window.addEventListener('online', schedule);

  function relevant(data) {
    if (!thread || !data || !data.payload) return false;
    // A run's payload carries the environment it deployed ('pull-<n>' or
    // 'production'), never the pull's own 'number' field, so the generic
    // check below never fires for it. A pull's checks are the deploy runs
    // of its own preview, so match on that instead — and only that, so a
    // run on a different pull (or on production) never flips this page.
    if (thread === 'pull' && data.kind.indexOf('run.') === 0) {
      return data.payload.env === 'pull-' + number;
    }
    if (String(data.payload.number) !== String(number)) return false;
    return data.kind.indexOf(thread) === 0;
  }

  var conv = document.getElementById('conversation');
  function appendNew() {
    var kind = thread === 'issue' ? 'issues' : 'pulls';
    fetch(repo + '/' + kind + '/' + number + '/thread?after=' + encodeURIComponent(lastId), {
      headers: { accept: 'text/html' },
    })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        if (!text || !conv) return;
        var holder = document.createElement('div');
        holder.innerHTML = text;
        var nodes = holder.querySelectorAll(':scope > [data-comment-id]');
        for (var i = 0; i < nodes.length; i++) {
          conv.appendChild(nodes[i]);
          lastId = nodes[i].getAttribute('data-comment-id') || lastId;
        }
        if (nodes.length > 0) say(nodes.length === 1 ? '1 new comment' : nodes.length + ' new comments');
      })
      .catch(function () {});
  }

  // A deploy run for the app this page is about: refetch the app's own
  // fragment and swap the head card and previews list in place, so a change
  // serving in its preview shows up without a reload. At most one fetch in
  // flight — a burst of queued/started/finished for the same push collapses
  // to whatever the last one finds.
  var appBusy = false, appQueued = false;
  function textOf(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  // The head card's own word, whatever envPhrase drew into its badge.
  function headWord(root) {
    return textOf(root && root.querySelector('.page-head h1 .badge'));
  }
  // When the word is "live", the timing phrase envFacts already printed
  // under it — never a second way of saying how fast.
  function headPhrase(root) {
    var spans = root ? root.querySelectorAll('.page-head .env-facts span') : [];
    for (var i = 0; i < spans.length; i++) {
      var t = textOf(spans[i]);
      if (t.indexOf('live ') === 0) return t;
    }
    return '';
  }
  // One preview row's own word, keyed by the "#N title" every row states
  // first in its meta line, whichever else the title slot shows.
  function rowWords(root) {
    var out = {};
    var items = root ? root.querySelectorAll('#app-previews .list > li') : [];
    for (var i = 0; i < items.length; i++) {
      var meta = textOf(items[i].querySelector('.row-meta'));
      var label = meta.split(' · ')[0] || textOf(items[i].querySelector('.row-title'));
      if (label) out[label] = textOf(items[i].querySelector('.row-trail .badge'));
    }
    return out;
  }
  // One sentence for whatever changed between the fragment on screen and the
  // one just fetched, in the card's own words — never a second vocabulary.
  // A fragment that reads the same as what's already there returns '', so a
  // swap that changes nothing visible announces nothing.
  function announceSwap(oldHead, oldPrev, newHead, newPrev) {
    var was = headWord(oldHead), is = headWord(newHead);
    if (is && is !== was) return is === 'live' ? (headPhrase(newHead) || is) : is;
    var before = rowWords(oldPrev), after = rowWords(newPrev);
    for (var label in after) {
      if (after[label] !== before[label]) return label + ' — ' + after[label];
    }
    return '';
  }
  function isDeploy(data) {
    return isApp && data && data.kind && data.kind.indexOf('run.') === 0 &&
      data.payload && data.payload.kind === 'deploy';
  }
  // While a new app's head carries where it stands ([data-onboarding],
  // apps/onboarding.ts), the crew's runs and its pulls opening, landing or
  // closing move it too. Once live the row is gone, and so is this.
  function movesOnboarding(data) {
    return isApp && data && data.kind &&
      !!document.querySelector('#app-head [data-onboarding]') &&
      (data.kind.indexOf('run.') === 0 || data.kind === 'pull.opened' ||
       data.kind === 'pull.merged' || data.kind === 'pull.closed');
  }
  // 'app.serving' fires at the swap-in — the instant a preview answers —
  // which is seconds to half a minute before its tests (and so its
  // run.finished) are done. It carries no run.kind, so it is matched on its
  // own kind and on the app/env it names, never on a deploy run's shape.
  function isServing(data) {
    return isApp && data && data.kind === 'app.serving' && data.payload &&
      typeof data.payload.app === 'string' && typeof data.payload.env === 'string';
  }
  function refreshApp() {
    if (appBusy) { appQueued = true; return; }
    appBusy = true;
    fetch(repo + '/app/state', { headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        if (!text) return;
        var holder = document.createElement('div');
        holder.innerHTML = text;
        var oldHead = document.getElementById('app-head');
        var oldPrev = document.getElementById('app-previews');
        var newHead = holder.querySelector('#app-head');
        var newPrev = holder.querySelector('#app-previews');
        var line = announceSwap(oldHead, oldPrev, newHead, newPrev);
        ['app-head', 'app-previews'].forEach(function (id) {
          var mine = document.getElementById(id);
          var theirs = holder.querySelector('#' + id);
          if (!mine || !theirs) return;
          var changed = mine.innerHTML !== theirs.innerHTML;
          mine.replaceWith(theirs);
          // A transition, not a resize: the card keeps its own height, and
          // prefers-reduced-motion already collapses every animation's
          // duration to nothing (style/base.ts), this one included.
          if (changed) {
            theirs.classList.add('studio-just-changed');
            theirs.addEventListener('animationend', function () {
              theirs.classList.remove('studio-just-changed');
            });
          }
        });
        if (line) say(line.charAt(0).toUpperCase() + line.slice(1));
      })
      .catch(function () {})
      .then(function () {
        appBusy = false;
        if (appQueued) { appQueued = false; refreshApp(); }
      });
  }

  // A change's own page: its word, note, deploy link and Preview card follow
  // the change without a reload. Only three things move them — this pull
  // merging, a deploy run of its own preview, and production serving at its
  // head — and a burst of them collapses to one fetch in flight.
  var pullBusy = false, pullQueued = false;
  function movesPull(data) {
    if (thread !== 'pull' || !data || !data.payload) return false;
    if (data.kind === 'pull.merged') return String(data.payload.number) === String(number);
    if (data.kind.indexOf('run.') === 0) return data.payload.env === 'pull-' + number;
    if (data.kind === 'app.serving') {
      return data.payload.env === 'production' && !!head && data.payload.commitOid === head;
    }
    return false;
  }
  function refreshPull() {
    if (pullBusy) { pullQueued = true; return; }
    pullBusy = true;
    fetch(repo + '/pulls/' + number + '/state', { headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        if (!text) return;
        var holder = document.createElement('div');
        holder.innerHTML = text;
        ['pull-check', 'pull-preview'].forEach(function (id) {
          var mine = document.getElementById(id);
          var theirs = holder.querySelector('#' + id);
          if (mine && theirs && mine.innerHTML !== theirs.innerHTML) mine.replaceWith(theirs);
        });
        var mark = document.querySelector('#pull-check [data-head]');
        if (mark && mark.getAttribute('data-head')) head = mark.getAttribute('data-head');
        var word = textOf(document.querySelector('#pull-check [data-pull-word]'));
        if (word) say(word.charAt(0).toUpperCase() + word.slice(1));
      })
      .catch(function () {})
      .then(function () {
        pullBusy = false;
        if (pullQueued) { pullQueued = false; refreshPull(); }
      });
  }

  function onEvent(e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    if (movesPull(data)) {
      refreshPull();
      return;
    }
    if (isDeploy(data) || isServing(data) || movesOnboarding(data)) { refreshApp(); return; }
    if (relevant(data) && conv && (data.kind === thread + '.commented')) {
      appendNew();
    } else if (!thread) {
      schedule();
    }
  }

  var KINDS = [
    'push', 'repo.created', 'repo.forked',
    'issue.opened', 'issue.closed', 'issue.reopened', 'issue.commented', 'issue.labeled', 'issue.teams', 'issue.edited',
    'pull.opened', 'pull.closed', 'pull.reopened', 'pull.merged', 'pull.commented', 'pull.reviewed',
    'pull.held', 'pull.released', 'pull.edited', 'pull.run_granted', 'pull.guest_approved',
    'branch.created', 'branch.deleted',
    'label.created', 'label.updated', 'label.deleted',
    'run.queued', 'run.started', 'run.finished', 'app.serving',
    'schedule.steered', 'app.created', 'app.updated', 'app.deleted', 'app.stopped',
    'repo.upstream_checked', 'repo.links_probed', 'repo.source_added', 'repo.source_removed', 'repo.upstream_follow', 'repo.following', 'limb.moved', 'limb.replan', 'limb.replan_taken_back', 'issue.assigned', 'pull.assigned', 'crew.added', 'crew.removed',
  ];
  var extra = (cfg.getAttribute('data-repos') || '').split(' ').filter(Boolean);
  var watching = [repo].concat(extra).filter(function (r, i, all) {
    return r && all.indexOf(r) === i;
  }).slice(0, 3);
  var conn = document.getElementById('live-conn');
  var downTimer = null;
  // "offline" shows only once a stream has been down for a moment: one that
  // errors while the page navigates or unloads never flashes it.
  function down() {
    if (downTimer || !conn) return;
    downTimer = setTimeout(function () { conn.hidden = false; }, DOWN_AFTER);
  }
  function up() {
    if (downTimer) { clearTimeout(downTimer); downTimer = null; }
    if (conn) conn.hidden = true;
  }
  watching.forEach(function (at) {
    var es = new EventSource(at + '/stream');
    var dropped = false;
    // A dropped stream says so in a word; the browser reconnects by itself,
    // and when it is back the page catches up on what it missed.
    es.addEventListener('error', function () {
      dropped = true;
      down();
    });
    es.addEventListener('open', function () {
      up();
      if (dropped) { dropped = false; if (!thread) schedule(); }
    });
    KINDS.forEach(function (k) { es.addEventListener(k, onEvent); });
  });
})();
`;
