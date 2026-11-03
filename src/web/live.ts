/**
 * The live-updates client: a small, framework-free EventSource consumer. It
 * reads its configuration from a `#live` element's data attributes (never from
 * interpolated script text — the CSP forbids that anyway) and:
 *   - on a comment for the thread you're viewing, fetches the new comments and
 *     appends them, so a conversation updates as people type;
 *   - on any other relevant activity, reveals a "new activity" pill that
 *     reloads on click.
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
   * rather than only offering the pill.
   */
  app?: boolean;
}

/** The config element, the polite status line, and the (hidden) activity pill. */
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
      <a id="live-pill" class="badge" data-variant="attn" href="" hidden
        >↻ New activity — refresh</a
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
  var pill = document.getElementById('live-pill');
  var status = document.getElementById('live-status');
  var conv = document.getElementById('conversation');

  // A count, not a reload. Yanking the page out from under a reader to show
  // them something new is the one thing a live list must never do.
  var fresh = 0;
  function showPill() {
    if (!pill) return;
    fresh++;
    pill.textContent = '\\u21bb ' + fresh + ' new — refresh';
    pill.hidden = false;
  }
  if (pill) pill.addEventListener('click', function (e) { e.preventDefault(); location.reload(); });

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
        if (status && nodes.length > 0) {
          status.textContent = nodes.length === 1 ? '1 new comment' : nodes.length + ' new comments';
        }
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
        if (status && line) status.textContent = line.charAt(0).toUpperCase() + line.slice(1);
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
        if (status && word) status.textContent = word.charAt(0).toUpperCase() + word.slice(1);
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
      // A merge changes more than the word (the decision, the composer):
      // it still offers the refresh. A run or a serving moves only the swap.
      if (data.kind !== 'pull.merged') return;
    }
    if (isDeploy(data) || isServing(data)) { refreshApp(); return; }
    if (relevant(data) && conv && (data.kind === thread + '.commented')) {
      appendNew();
    } else if (relevant(data) || !thread) {
      showPill();
      if (status) status.textContent = 'New activity on this page';
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
    'app.created', 'app.updated', 'app.deleted', 'app.stopped',
    'repo.upstream_checked', 'repo.upstream_follow', 'repo.following', 'limb.moved', 'limb.replan', 'limb.replan_taken_back', 'issue.assigned', 'pull.assigned', 'crew.added', 'crew.removed',
  ];
  var extra = (cfg.getAttribute('data-repos') || '').split(' ').filter(Boolean);
  var watching = [repo].concat(extra).filter(function (r, i, all) {
    return r && all.indexOf(r) === i;
  }).slice(0, 3);
  watching.forEach(function (at) {
    var es = new EventSource(at + '/stream');
    KINDS.forEach(function (k) { es.addEventListener(k, onEvent); });
  });
})();
`;
