/**
 * The `flow` label in a fresh process, loaded as `src/main.ts` loads the
 * forge at boot (`test/flow-label-dispatch.test.ts`): the app and the HTTP
 * server's module graph, then a top-level await, then an owner labels a held
 * issue `flow`. `actions/issues.ts` loads the dispatcher only at that call, so
 * a dispatcher that cannot load cold fails here and nowhere earlier.
 *
 * Printed: the number of agent runs on the issue afterwards.
 */
import { createApp } from "../../src/app.ts";
import "../../src/http/server.ts";
import { setIssueLabels } from "../../src/actions/issues.ts";
import { getIssue } from "../../src/core/issues.ts";
import { getRepo } from "../../src/core/repos.ts";
import { getUserByName } from "../../src/core/users.ts";

const [dataDir, owner, name, number] = process.argv.slice(2);
const app = createApp({ dataDir: dataDir!, port: 0 });
await Bun.sleep(0);
const repo = getRepo(app.db, owner!, name!)!;
const issue = getIssue(app.db, repo.id, Number(number))!;
const labelled = setIssueLabels(app, getUserByName(app.db, owner!)!, repo, issue, ["flow"]);
if (!labelled.ok) throw new Error(String(labelled.error));
const runs = app.db
  .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'agent'")
  .get(issue.id)!.n;
app.close();
console.log(runs);
