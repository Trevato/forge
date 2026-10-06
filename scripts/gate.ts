/**
 * Which test files the gate runs, and why every other one does not.
 *
 * `GATE` is the list `bun scripts/test-shards.ts --gate` runs, so
 * `forge.json`'s `check.run` names no test file itself. `EXCLUDED` is every
 * other `test/*.test.ts`, each with the reason it is out and the issue that
 * owns bringing it in. `test/check-list.test.ts` goes red when a file is in
 * neither list, in both, or named here without existing — so a new test file
 * cannot sit outside the gate silently.
 *
 * A file joins the gate by moving from `EXCLUDED` to `GATE` in a pull whose
 * check is green.
 */

export type Exclusion = {
  /** Repository-relative path, `test/….test.ts`. */
  file: string;
  /** One line: why the gate does not run it today. */
  reason: string;
  /** The issue that owns admitting it. */
  issue: number;
};

export const GATE: readonly string[] = [
  "test/accounts.test.ts",
  "test/app-domains.test.ts",
  "test/app.test.ts",
  "test/body-limits.test.ts",
  "test/claim-link.test.ts",
  "test/client-address.test.ts",
  "test/contents-api.test.ts",
  "test/crew.test.ts",
  "test/commit-identity.test.ts",
  "test/returns.test.ts",
  "test/review-route.test.ts",
  "test/review-lines.test.ts",
  "test/review-gate.test.ts",
  "test/crew-wrapup.test.ts",
  "test/crew-limits.test.ts",
  "test/crew-parks.test.ts",
  "test/crew-sandbox.test.ts",
  "test/crew-direction.test.ts",
  "test/crew-direction-autonomy.test.ts",
  "test/crew-guard.test.ts",
  "test/scale.test.ts",
  "test/settings.test.ts",
  "test/signins.test.ts",
  "test/steer.test.ts",
  "test/session-settle.test.ts",
  "test/landing.test.ts",
  "test/decide.test.ts",
  "test/ledger.test.ts",
  "test/checks.test.ts",
  "test/dependencies.test.ts",
  "test/map-closing.test.ts",
  "test/autonomy.test.ts",
  "test/studio.test.ts",
  "test/studio-words.test.ts",
  "test/following.test.ts",
  "test/forks.test.ts",
  "test/front.test.ts",
  "test/fork-counts.test.ts",
  "test/fork-flow.test.ts",
  "test/fork-pull-approval.test.ts",
  "test/cross-repo-pull.test.ts",
  "test/pulls.test.ts",
  "test/api-reader-marks.test.ts",
  "test/app-members.test.ts",
  "test/apps.test.ts",
  "test/apps-adversarial.test.ts",
  "test/apps-busy.test.ts",
  "test/apps-token.test.ts",
  "test/contain.test.ts",
  "test/subscription-budget.test.ts",
  "test/surfaces-adversarial.test.ts",
  "test/orgs.test.ts",
  "test/verify-email.test.ts",
  "test/web.test.ts",
  "test/git-trust.test.ts",
  "test/helpers.test.ts",
  "test/shards.test.ts",
  "test/migrate.test.ts",
  "test/schema-migrations.test.ts",
  "test/vitals.test.ts",
  "test/guard.test.ts",
  "test/asked.test.ts",
  "test/asks.test.ts",
  "test/asks-bulk.test.ts",
  "test/asks-expiry.test.ts",
  "test/asks-rank.test.ts",
  "test/plan-pillars.test.ts",
  "test/planner-declined.test.ts",
  "test/feed.test.ts",
  "test/feed-page.test.ts",
  "test/offline.test.ts",
  "test/share.test.ts",
  "test/cloud.test.ts",
  "test/run-secrets.test.ts",
  "test/reserved-names.test.ts",
  "test/forge-cloudflare.test.ts",
  "test/forge-cloudflare-celld.test.ts",
  "test/branch_tell.test.ts",
  "test/usage.test.ts",
  "test/tokens.test.ts",
  "test/credentials.test.ts",
  "test/standing.test.ts",
  "test/board.test.ts",
  "test/spawn-plan.test.ts",
  "test/spawn.test.ts",
  "test/spawn-api.test.ts",
  "test/spawn-child-apps.test.ts",
  "test/spawn-first-boot.test.ts",
  "test/spawn-keys.test.ts",
  "test/web-apps.test.ts",
  "test/fleet-ops.test.ts",
  "test/meter.test.ts",
  "test/told-by.test.ts",
  "test/highlight.test.ts",
  "test/diff.test.ts",
  "test/edge-auth.test.ts",
  "test/edits-security.test.ts",
  "test/edits.test.ts",
  "test/event-audience.test.ts",
  "test/everyday.test.ts",
  "test/explore.test.ts",
  "test/feeds.test.ts",
  "test/fleet-graph.test.ts",
  "test/git-local.test.ts",
  "test/git-ssh.test.ts",
  "test/git.test.ts",
  "test/hardening.test.ts",
  "test/here-manifest.test.ts",
  "test/image-gif.test.ts",
  "test/image-graphics.test.ts",
  "test/image-jpeg.test.ts",
  "test/image-png.test.ts",
  "test/issues.test.ts",
  "test/kernel.test.ts",
  "test/keys.test.ts",
  "test/live-pages.test.ts",
  "test/live.test.ts",
  "test/looks.test.ts",
  "test/mail-caps.test.ts",
  "test/make-it-yours.test.ts",
  "test/map.test.ts",
  "test/pillars.test.ts",
  "test/mcp.test.ts",
  "test/notify.test.ts",
  "test/onboarding.test.ts",
  "test/origins-oauth.test.ts",
  "test/origins-operator.test.ts",
  "test/origins-security-auth.test.ts",
  "test/origins-security-push.test.ts",
  "test/origins-sync.test.ts",
  "test/origins.test.ts",
  "test/outsiders-switch.test.ts",
  "test/check-list.test.ts",
  "test/holds.test.ts",
  "test/hollow.test.ts",
  "test/home-feed.test.ts",
  "test/oauth-discovery.test.ts",
  "test/data-home.test.ts",
  "test/tree.test.ts",
  "test/reports.test.ts",
  "test/report-discovery.test.ts",
  "test/apps-report.test.ts",
  "test/private-app.test.ts",
];

export const EXCLUDED: readonly Exclusion[] = [
  { file: "test/actions.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/agents.test.ts",
    reason: "red: fifty concurrent pushes come back 'auth required'",
    issue: 293,
  },
  { file: "test/api-errors.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/app-env.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/apps-api.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/apps-idle.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/apps-open-host.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/apps-sleep.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/apps-ssh.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/apps-ws.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/audit.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/board-windows.test.ts",
    reason: "red: an app with spend and nothing shipped is missing from the board",
    issue: 555,
  },
  { file: "test/branches.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/cli-sync.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/code.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/contract.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/counts.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/crew-interrupted.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/crew-loop.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/crew-totals.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/diff-edge-cases.test.ts",
    reason: "red: wall-clock bounds (5 s, 200 ms) fail on a loaded machine",
    issue: 584,
  },
  {
    file: "test/origins-security-provider.test.ts",
    reason: "red: the off-host redirect test cannot connect to its own localhost origin",
    issue: 585,
  },
  { file: "test/pacing.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/palette.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/parity.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/policy.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/probe.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/probes.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/prompts.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/public-url.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/push-through.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/qr.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/read-api.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/revert.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/reviews-states.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/reviews.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/runs-lease.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/scaffold.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/search.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/secret-store.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/security-merge.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/security-xss.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/signin-throttle.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  {
    file: "test/snapshot-destination.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/snapshot.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/spawn-placement.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/sse.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/ssh-app.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/ssh-port-taken.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  {
    file: "test/ssh-site.test.ts",
    reason:
      "red: asserts the dashboard and studio pages as they were before the redesign",
    issue: 291,
  },
  { file: "test/ssh.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/standards.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/studio-phone.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/subscriptions.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/tui-app.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-apps.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-code.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-editor.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-icons.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-input.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-local.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-mouse.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-render.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-screens.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-size.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-widgets.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/tui-width.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/tui-workflows.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  {
    file: "test/tui-workspace.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/view-source.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/web-browse.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/web-code.test.ts",
    reason:
      "red: asserts the dashboard and studio pages as they were before the redesign",
    issue: 291,
  },
  { file: "test/web-editor.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/web-origins.test.ts",
    reason:
      "red: asserts the dashboard and studio pages as they were before the redesign",
    issue: 291,
  },
  { file: "test/web-phone.test.ts", reason: "not yet admitted", issue: 261 },
  { file: "test/web-ui.test.ts", reason: "not yet admitted", issue: 261 },
  {
    file: "test/web-workflows.test.ts",
    reason: "not yet admitted",
    issue: 261,
  },
  { file: "test/webhooks.test.ts", reason: "not yet admitted", issue: 261 },
];

/**
 * Everything wrong with a gate list, against the test files that exist:
 * one line per problem, none when every file is accounted for exactly once.
 */
export function auditGate(
  present: readonly string[],
  gate: readonly string[],
  excluded: readonly Exclusion[],
): string[] {
  const problems: string[] = [];
  const exists = new Set(present);
  const gated = new Set<string>();
  for (const file of gate) {
    if (gated.has(file)) problems.push(`${file} is in GATE twice`);
    gated.add(file);
    if (!exists.has(file))
      problems.push(`${file} is in GATE but does not exist`);
  }
  const out = new Set<string>();
  for (const { file, reason, issue } of excluded) {
    if (out.has(file)) problems.push(`${file} is in EXCLUDED twice`);
    out.add(file);
    if (!exists.has(file))
      problems.push(`${file} is in EXCLUDED but does not exist`);
    if (gated.has(file)) problems.push(`${file} is in both GATE and EXCLUDED`);
    if (typeof reason !== "string" || reason.trim() === "")
      problems.push(`${file} is excluded with no reason`);
    if (!Number.isInteger(issue) || issue <= 0)
      problems.push(`${file} is excluded with no issue number`);
  }
  for (const file of present)
    if (!gated.has(file) && !out.has(file))
      problems.push(`${file} is in neither GATE nor EXCLUDED`);
  return problems;
}
