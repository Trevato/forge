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

export interface LiveConfig {
  /** Repo base path, e.g. "/alice/app". */
  repo: string;
  /** "issue" | "pull" for a thread page; omit on lists. */
  thread?: "issue" | "pull";
  /** The issue/PR number, for a thread page. */
  number?: number;
  /** Id of the last comment already on the page (for the ?after= fetch). */
  lastCommentId?: string;
}

/** The config element, the polite status line, and the (hidden) activity pill. */
export function liveMount(config: LiveConfig): Html {
  return html`<div
      id="live"
      hidden
      data-repo="${config.repo}"
      data-thread="${config.thread ?? ""}"
      data-number="${config.number ?? ""}"
      data-last="${config.lastCommentId ?? ""}"
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
  var pill = document.getElementById('live-pill');
  var status = document.getElementById('live-status');
  var conv = document.getElementById('conversation');

  function showPill() { if (pill) { pill.hidden = false; } }
  if (pill) pill.addEventListener('click', function (e) { e.preventDefault(); location.reload(); });

  function relevant(data) {
    if (!thread || !data || !data.payload) return false;
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

  function onEvent(e) {
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    if (relevant(data) && conv && (data.kind === thread + '.commented')) {
      appendNew();
    } else if (relevant(data) || !thread) {
      showPill();
      if (status) status.textContent = 'New activity on this page';
    }
  }

  var es = new EventSource(repo + '/stream');
  [
    'push', 'repo.created', 'repo.forked',
    'issue.opened', 'issue.closed', 'issue.reopened', 'issue.commented', 'issue.labeled',
    'pull.opened', 'pull.closed', 'pull.reopened', 'pull.merged', 'pull.commented', 'pull.reviewed',
    'label.created', 'label.updated', 'label.deleted',
  ].forEach(function (k) { es.addEventListener(k, onEvent); });
})();
`;
