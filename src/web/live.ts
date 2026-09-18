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
 * is told something arrived without re-reading the thread.
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
      data-app="${config.app ? "1" : ""}"
    ></div>
    <p
      class="live-status"
      id="live-status"
      role="status"
      aria-live="polite"
    ></p>
    <a id="live-pill" class="live-pill" href="" hidden
      >↻ New activity — refresh</a
    >`;
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
        ['app-head', 'app-previews'].forEach(function (id) {
          var mine = document.getElementById(id);
          var theirs = holder.querySelector('#' + id);
          if (mine && theirs) mine.replaceWith(theirs);
        });
      })
      .catch(function () {})
      .then(function () {
        appBusy = false;
        if (appQueued) { appQueued = false; refreshApp(); }
      });
  }

  function onEvent(e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
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
    'issue.opened', 'issue.closed', 'issue.reopened', 'issue.commented', 'issue.labeled',
    'pull.opened', 'pull.closed', 'pull.reopened', 'pull.merged', 'pull.commented', 'pull.reviewed',
    'branch.created', 'branch.deleted',
    'label.created', 'label.updated', 'label.deleted',
    'run.queued', 'run.started', 'run.finished', 'app.serving',
    'app.created', 'app.updated', 'app.deleted', 'app.stopped',
    'issue.assigned', 'pull.assigned', 'crew.added', 'crew.removed',
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
