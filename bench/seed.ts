/**
 * Seed a forge with the shape a busy one has: many repos, many conversations,
 * real git histories. The point is not "a big database" — it is a database
 * whose *distribution* matches the thing we are afraid of, so a query plan
 * that scans shows up as a plan that scans.
 *
 *   bun run bench/seed.ts --data .bench/data
 *   bun run bench/seed.ts --data .bench/data --repos 200 --issues 2000
 *
 * Cheap where the shape does not matter (rows go in through core, batched
 * inside transactions) and honest where it does (every repo is a real bare
 * repo with real commits, because that is what the read paths spawn git
 * against). Git work runs at the concurrency the spawn semaphore allows —
 * the seeder is the first thing that would fork-bomb the host if it did not.
 */

import { mkdirSync, rmSync } from "node:fs";
import { createApp, type App } from "../src/app.ts";
import { createIssue, nextNumber } from "../src/core/issues.ts";
import { createRepo as coreCreateRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { resolveOid, writeRef } from "../src/git/merge.ts";
import { id } from "../src/kernel/id.ts";
import { setLogLevel } from "../src/kernel/log.ts";

export interface SeedPlan {
  readonly dataDir: string;
  readonly users: number;
  readonly repos: number;
  readonly issues: number;
  readonly pulls: number;
  readonly comments: number;
  /** Commits on a repo's default branch. */
  readonly commits: number;
  /** Distinct labels created per repo. */
  readonly labels: number;
  /** How many git subprocesses to have in flight while seeding. */
  readonly concurrency: number;
  readonly fresh: boolean;
}

export const DEFAULT_PLAN: Omit<SeedPlan, "dataDir"> = {
  users: 20,
  repos: 2_000,
  issues: 20_000,
  pulls: 2_000,
  comments: 100_000,
  commits: 3,
  labels: 4,
  concurrency: 12,
  fresh: true,
};

/** What the bench needs to find its way around the seeded forge. */
export interface SeedResult {
  readonly plan: SeedPlan;
  /** Every seeded login; `users[0]` is the site admin. */
  readonly users: readonly string[];
  /** `owner/name` of a repo with the full fixture (history, issues, a pull). */
  readonly hotRepo: string;
  /** An issue number on `hotRepo` carrying HEAVY_COMMENTS comments. */
  readonly heavyIssue: number;
  /** A pull number on `hotRepo` whose diff is HEAVY_DIFF_LINES lines. */
  readonly heavyPull: number;
  /** A token secret with `rw` scope belonging to `users[0]`. */
  readonly token: string;
  readonly seconds: number;
}

/** The "one huge thread" case every forge eventually grows. */
export const HEAVY_COMMENTS = 200;
/** The "review this monster" case. */
export const HEAVY_DIFF_LINES = 3_000;

const PASSWORD = "bench-passphrase-0";

// ---- a tiny bounded-concurrency map, because git is the expensive part ----

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    })(),
  );
  await Promise.all(workers);
  return out;
}

const pad = (n: number, width = 5): string => String(n).padStart(width, "0");

function progress(label: string, done: number, total: number): void {
  if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) {
    process.stdout.write(`  ${label}: ${done}/${total}\r`);
    if (done === total)
      process.stdout.write(`  ${label}: ${total} ✓        \n`);
  }
}

// ---- the seed ----

export async function seed(plan: SeedPlan): Promise<SeedResult> {
  const started = Date.now();
  setLogLevel("error");
  if (plan.fresh) rmSync(plan.dataDir, { recursive: true, force: true });
  mkdirSync(plan.dataDir, { recursive: true });

  const app = createApp({ dataDir: plan.dataDir, port: 0 });
  const db = app.db;

  // --- users. Argon2 is deliberately slow, so hash one password and reuse
  // the digest: the bench measures reads, not the KDF. ---
  console.log(`seeding ${plan.users} users`);
  const first = await createUser(db, {
    username: "bench0",
    email: "bench0@forge.test",
    password: PASSWORD,
    origin: "seed",
    adminIfFirst: true,
  });
  if (!first.ok) throw new Error(`seed user: ${first.error}`);
  const hash = db
    .query<
      { password_hash: string },
      [string]
    >("SELECT password_hash FROM user WHERE id = ?1")
    .get(first.value.id)!.password_hash;

  const users = [first.value];
  const insertUser = db.query(
    `INSERT INTO user (id, username, email, password_hash, display_name)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  );
  db.transaction(() => {
    for (let i = 1; i < plan.users; i++) {
      const uid = id();
      insertUser.run(
        uid,
        `bench${i}`,
        `bench${i}@forge.test`,
        hash,
        `Bench ${i}`,
      );
      users.push({ ...first.value, id: uid, username: `bench${i}` });
    }
  })();
  const userIds = users.map((u) => u.id);

  // A token for the API half of the bench. Minted here rather than through
  // the action so the secret is known without a sign-in round trip.
  const tokenSecret = `forge_bench_${id()}`;
  const { sha256 } = await import("../src/kernel/hash.ts");
  db.query(
    "INSERT INTO token (id, token_hash, user_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(id(), sha256(tokenSecret), userIds[0]!, "bench", "rw");

  // --- repos: real bare repos with real commits ---
  console.log(
    `seeding ${plan.repos} repos (git init + ${plan.commits} commits each)`,
  );
  const repoNames = Array.from(
    { length: plan.repos },
    (_, i) => `repo-${pad(i)}`,
  );
  let built = 0;
  const repoIds = await mapLimit(
    repoNames,
    plan.concurrency,
    async (name, i) => {
      const owner = users[i % users.length]!;
      const created = await coreCreateRepo(db, app.reposRoot, {
        ownerId: owner.id,
        name,
        // Public: the visibility filter is a join we want exercised, and a
        // bench that could not read its own repos would measure nothing.
        visibility: i % 5 === 0 ? "private" : "public",
        description: `Bench repository ${i}`,
      });
      if (!created.ok) throw new Error(`seed repo ${name}: ${created.error}`);
      const dir = repoDir(app.reposRoot, owner.username, name);
      for (let c = 0; c < plan.commits; c++) {
        const committed = await commitFiles(dir, {
          branch: "main",
          message: `Commit ${c} on ${name}`,
          files: [
            { path: "README.md", content: `# ${name}\n\nrevision ${c}\n` },
            { path: `src/mod${c}.ts`, content: bodyText(name, c) },
          ],
          author: { name: owner.username, email: owner.email },
        });
        if (!committed.ok)
          throw new Error(`seed commit: ${JSON.stringify(committed.error)}`);
      }
      progress("repos", ++built, plan.repos);
      return created.value.id;
    },
  );

  // --- labels, in one transaction ---
  console.log(`seeding labels`);
  const labelNames = ["bug", "chore", "design", "urgent", "docs", "flake"];
  const labelIds = new Map<string, string[]>();
  const insertLabel = db.query(
    "INSERT INTO label (id, repo_id, name, color) VALUES (?1, ?2, ?3, ?4)",
  );
  db.transaction(() => {
    for (const repoId of repoIds) {
      const ids: string[] = [];
      for (let l = 0; l < plan.labels; l++) {
        const lid = id();
        insertLabel.run(
          lid,
          repoId,
          labelNames[l % labelNames.length]!,
          "d73a4a",
        );
        ids.push(lid);
      }
      labelIds.set(repoId, ids);
    }
  })();

  // --- issues, comments, labels. Batched in transactions of BATCH rows so
  // one interrupted seed does not mean starting over, and so the WAL does
  // not grow to hold twenty thousand statements. ---
  console.log(`seeding ${plan.issues} issues + ${plan.comments} comments`);
  const BATCH = 2_000;
  const insertIssue = db.query(
    `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  );
  const bumpSeq = db.query(
    "UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq",
  );
  const insertComment = db.query(
    `INSERT INTO comment (id, issue_id, author_id, body, kind, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'comment', ?5, ?5)`,
  );
  const insertIssueLabel = db.query(
    "INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?1, ?2)",
  );

  const issueIds: string[] = [];
  const perComment = Math.max(
    0,
    Math.floor(plan.comments / Math.max(1, plan.issues)),
  );
  const clock = Date.now() - plan.issues * 1000;
  for (let start = 0; start < plan.issues; start += BATCH) {
    const end = Math.min(start + BATCH, plan.issues);
    db.transaction(() => {
      for (let i = start; i < end; i++) {
        const repoId = repoIds[i % repoIds.length]!;
        const issueId = id();
        const number = bumpSeq.get(repoId) as { issue_seq: number };
        const when = new Date(clock + i * 1000).toISOString();
        insertIssue.run(
          issueId,
          repoId,
          number.issue_seq,
          "issue",
          `Issue ${i}: ${TITLES[i % TITLES.length]}`,
          `Something is wrong in module ${i % 40}.\n\nSteps to reproduce follow.\n`,
          userIds[i % userIds.length]!,
          i % 3 === 0 ? "closed" : "open",
          when,
        );
        issueIds.push(issueId);
        for (const lid of (labelIds.get(repoId) ?? []).slice(0, 1 + (i % 2))) {
          insertIssueLabel.run(issueId, lid);
        }
        for (let c = 0; c < perComment; c++) {
          insertComment.run(
            id(),
            issueId,
            userIds[(i + c) % userIds.length]!,
            `Comment ${c} on issue ${i}. ${LOREM}`,
            new Date(clock + i * 1000 + c * 10).toISOString(),
          );
        }
      }
    })();
    progress("issues", end, plan.issues);
  }

  // --- pulls: a real feature branch and a real merge base per pull ---
  console.log(`seeding ${plan.pulls} pulls`);
  const insertPull = db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
     VALUES (?1, 'main', ?2, ?3, ?4, ?5)`,
  );
  let madePulls = 0;
  const pullTargets = Array.from({ length: plan.pulls }, (_, i) => i);
  await mapLimit(pullTargets, plan.concurrency, async (i) => {
    const index = i % repoIds.length;
    const repoId = repoIds[index]!;
    const owner = users[index % users.length]!;
    const dir = repoDir(app.reposRoot, owner.username, repoNames[index]!);
    const branch = `feature-${pad(i)}`;
    const committed = await commitFiles(dir, {
      branch,
      startPoint: "main",
      message: `Feature ${i}`,
      files: [{ path: `src/feature${i}.ts`, content: bodyText(branch, i) }],
      author: { name: owner.username, email: owner.email },
    });
    if (!committed.ok) return;
    const baseOid = await resolveOid(dir, "refs/heads/main");
    if (baseOid === undefined) return;
    const issue = createIssue(db, {
      repoId,
      authorId: userIds[i % userIds.length]!,
      title: `Pull ${i}: ${TITLES[i % TITLES.length]}`,
      body: "Please review.",
      kind: "pull",
    });
    if (!issue.ok) return;
    insertPull.run(
      issue.value.id,
      branch,
      baseOid,
      committed.value.commitOid,
      repoId,
    );
    await writeRef(
      dir,
      `refs/pull/${issue.value.number}/head`,
      committed.value.commitOid,
    );
    progress("pulls", ++madePulls, plan.pulls);
  });

  // --- the hot fixture: one repo carrying the pathological cases ---
  console.log("seeding the heavy fixture (200-comment issue, 3000-line pull)");
  const hotOwner = users[0]!;
  const hotName = "hot";
  const hot = await coreCreateRepo(db, app.reposRoot, {
    ownerId: hotOwner.id,
    name: hotName,
    visibility: "public",
    description: "The repo the bench leans on",
  });
  if (!hot.ok) throw new Error(`seed hot repo: ${hot.error}`);
  const hotDir = repoDir(app.reposRoot, hotOwner.username, hotName);
  const baseLines = Array.from(
    { length: HEAVY_DIFF_LINES },
    (_, i) => `line ${i}`,
  );
  const seeded = await commitFiles(hotDir, {
    branch: "main",
    message: "Initial",
    files: [
      { path: "README.md", content: "# hot\n" },
      { path: "big.txt", content: `${baseLines.join("\n")}\n` },
    ],
    author: { name: hotOwner.username, email: hotOwner.email },
  });
  if (!seeded.ok) throw new Error("seed hot main");
  const changed = await commitFiles(hotDir, {
    branch: "wide",
    startPoint: "main",
    message: "Rewrite every line",
    files: [
      {
        path: "big.txt",
        content: `${baseLines.map((l, i) => `${l} rewritten ${i}`).join("\n")}\n`,
      },
    ],
    author: { name: hotOwner.username, email: hotOwner.email },
  });
  if (!changed.ok) throw new Error("seed hot wide");

  const heavyIssue = createIssue(db, {
    repoId: hot.value.id,
    authorId: hotOwner.id,
    title: "The thread that will not die",
    body: "Two hundred people have opinions.",
  });
  if (!heavyIssue.ok) throw new Error("seed heavy issue");
  db.transaction(() => {
    for (let c = 0; c < HEAVY_COMMENTS; c++) {
      insertComment.run(
        id(),
        heavyIssue.value.id,
        userIds[c % userIds.length]!,
        `Reply ${c}. ${LOREM} ${LOREM}`,
        new Date(clock + c * 1000).toISOString(),
      );
    }
  })();

  const heavyPullIssue = createIssue(db, {
    repoId: hot.value.id,
    authorId: hotOwner.id,
    title: "Rewrite every line of big.txt",
    body: "Sorry.",
    kind: "pull",
  });
  if (!heavyPullIssue.ok) throw new Error("seed heavy pull");
  const hotBase = (await resolveOid(hotDir, "refs/heads/main"))!;
  insertPull.run(
    heavyPullIssue.value.id,
    "wide",
    hotBase,
    changed.value.commitOid,
    hot.value.id,
  );
  await writeRef(
    hotDir,
    `refs/pull/${heavyPullIssue.value.number}/head`,
    changed.value.commitOid,
  );

  // Issues on the hot repo too, so its list page is a real list page.
  db.transaction(() => {
    for (let i = 0; i < 200; i++) {
      const issueId = id();
      const number = bumpSeq.get(hot.value.id) as { issue_seq: number };
      insertIssue.run(
        issueId,
        hot.value.id,
        number.issue_seq,
        "issue",
        `Hot issue ${i}: ${TITLES[i % TITLES.length]}`,
        "Body.",
        userIds[i % userIds.length]!,
        i % 3 === 0 ? "closed" : "open",
        new Date(clock + i * 1000).toISOString(),
      );
      for (let c = 0; c < 5; c++) {
        insertComment.run(
          id(),
          issueId,
          userIds[c % userIds.length]!,
          `Hot comment ${c}`,
          new Date(clock + i * 1000 + c).toISOString(),
        );
      }
    }
  })();

  // --- events: the dashboard reads these, and it reads them on every load ---
  console.log("seeding the event outbox");
  const insertEvent = db.query(
    "INSERT INTO event (id, kind, repo_id, actor_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  );
  const kinds = [
    "push",
    "issue.opened",
    "issue.commented",
    "pull.opened",
    "repo.created",
  ];
  const eventCount = Math.min(200_000, plan.issues * 4 + 5_000);
  for (let start = 0; start < eventCount; start += BATCH) {
    const end = Math.min(start + BATCH, eventCount);
    db.transaction(() => {
      for (let i = start; i < end; i++) {
        insertEvent.run(
          id(),
          kinds[i % kinds.length]!,
          repoIds[i % repoIds.length]!,
          userIds[i % userIds.length]!,
          JSON.stringify({ number: (i % 50) + 1 }),
          new Date(clock + i * 100).toISOString(),
        );
      }
    })();
    progress("events", end, eventCount);
  }

  // Pins, so the dashboard's pin card is not empty.
  db.transaction(() => {
    const insertPin = db.query(
      "INSERT OR IGNORE INTO pin (user_id, repo_id) VALUES (?1, ?2)",
    );
    for (let i = 0; i < Math.min(50, repoIds.length); i++) {
      insertPin.run(userIds[0]!, repoIds[i]!);
    }
    insertPin.run(userIds[0]!, hot.value.id);
  })();

  db.exec("PRAGMA optimize");
  db.exec("ANALYZE");
  app.close();

  const result: SeedResult = {
    plan,
    users: users.map((u) => u.username),
    hotRepo: `${hotOwner.username}/${hotName}`,
    heavyIssue: heavyIssue.value.number,
    heavyPull: heavyPullIssue.value.number,
    token: tokenSecret,
    seconds: (Date.now() - started) / 1000,
  };
  await Bun.write(
    `${plan.dataDir}/bench-seed.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

const TITLES = [
  "the lamp flickers at dusk",
  "cannot clone over ssh",
  "diff renders backwards",
  "labels lose their colour",
  "webhook retries forever",
  "the index drifts from git",
  "search misses closed issues",
  "terminal theme resets",
];

const LOREM =
  "This is roughly what a real comment weighs: a paragraph of prose, a code span, and a link.";

const bodyText = (name: string, n: number): string =>
  `export const ${name.replace(/[^a-zA-Z0-9]/g, "_")}_${n} = ${n};\n${Array.from(
    { length: 20 },
    (_, i) => `// note ${i} for revision ${n}`,
  ).join("\n")}\n`;

// ---- CLI ----

export function planFromArgs(argv: readonly string[]): SeedPlan {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const num = (name: string, fallback: number): number => {
    const raw = flag(name);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    dataDir: flag("data") ?? ".bench/data",
    users: num("users", DEFAULT_PLAN.users),
    repos: num("repos", DEFAULT_PLAN.repos),
    issues: num("issues", DEFAULT_PLAN.issues),
    pulls: num("pulls", DEFAULT_PLAN.pulls),
    comments: num("comments", DEFAULT_PLAN.comments),
    commits: num("commits", DEFAULT_PLAN.commits),
    labels: num("labels", DEFAULT_PLAN.labels),
    concurrency: num("concurrency", DEFAULT_PLAN.concurrency),
    fresh: !argv.includes("--keep"),
  };
}

if (import.meta.main) {
  const plan = planFromArgs(process.argv.slice(2));
  const result = await seed(plan);
  console.log(
    `\nseeded ${plan.repos} repos / ${plan.issues} issues / ${plan.comments} comments in ${result.seconds.toFixed(1)}s`,
  );
  console.log(`  data:  ${plan.dataDir}`);
  console.log(
    `  hot:   ${result.hotRepo} (issue #${result.heavyIssue}, pull #${result.heavyPull})`,
  );
}
