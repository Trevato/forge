/**
 * One of two forge processes on one data directory, as during a roll
 * (`test/overlap.test.ts`). It boots the forge over the shared data and,
 * from a moment both agreed on, does what both processes would do at once:
 *
 *   queue    ask the crew to take every issue in turn, the same issues in
 *            the same order as the process beside it
 *   deliver  send the webhook deliveries that are due, until none are
 *
 * Printed: how many runs this process queued, or deliveries it sent.
 */
import { createApp } from "../../src/app.ts";
import { getAgentByName } from "../../src/core/agents.ts";
import { getIssue } from "../../src/core/issues.ts";
import { getRepo } from "../../src/core/repos.ts";
import { deliverDue } from "../../src/core/webhooks.ts";
import { LOOPBACK } from "./loopback-hook.ts";
import { queueAgentRun } from "../../src/crew/dispatch.ts";
import "./roomy-disk.ts";

const [mode, dataDir, startAt, count] = process.argv.slice(2);
const app = createApp({ dataDir: dataDir!, port: 0 });
while (Date.now() < Number(startAt)) await Bun.sleep(1);
let done = 0;
if (mode === "queue") {
  const repo = getRepo(app.db, "alice", "garden")!;
  const agent = getAgentByName(app.db, "bot")!;
  for (let n = 1; n <= Number(count); n++) {
    const issue = getIssue(app.db, repo.id, n)!;
    if (queueAgentRun(app, repo, issue, agent, "assigned") !== undefined) done++;
  }
} else {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const sent = await deliverDue(app.db, app.log, new Date(), LOOPBACK);
    done += sent;
    if (sent === 0) await Bun.sleep(20);
  }
}
console.log(String(done));
app.close();
