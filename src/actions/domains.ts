/**
 * Domain actions: give an app a name of its own, check that the person who
 * added it holds it, and take it away. Admin over the repository, like
 * every other app setting. The check is the one thing here that leaves the
 * box — a DNS lookup — and it happens when someone asks, never on a timer.
 */

import type { App } from "../app.ts";
import { certificateSaid, probeCertificate } from "../apps/certificate.ts";
import { checkDomain, recordsFor, type DnsRecord } from "../apps/domains.ts";
import { appHostSuffix } from "../apps/host.ts";
import { appsRuntime, type AppsRuntime } from "../apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../core/apps.ts";
import {
  addDomain,
  getDomain,
  listDomains,
  recordCheck,
  removeDomain,
  type AddDomainError,
  type AppDomain,
} from "../core/domains.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireRepoAdmin } from "./access.ts";

/** A domain as a page or the API shows it: the facts, and what to publish. */
export interface AppDomainView {
  readonly host: string;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
  readonly checkedAt: string | null;
  readonly said: string;
  /** The proof, and where the traffic goes. */
  readonly records: DnsRecord[];
}

export type DomainError = "not_found" | "no_runtime";

/** The admin, and the app they administer. */
function admitted(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<{ admin: User; record: AppRecord }, "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const record = getAppByRepo(app.db, repo.id);
  if (!record) return err("not_found");
  return ok({ admin: admin.value, record });
}

/** A domain has nowhere to point when nothing serves apps. */
function serving(app: App): Result<AppsRuntime, "no_runtime"> {
  const runtime = appsRuntime(app);
  return runtime === undefined ? err("no_runtime") : ok(runtime);
}

/** The forge's own hostname — the one name no app may take. */
function forgeHost(app: App): string {
  return app.config.url !== undefined
    ? new URL(app.config.url).hostname
    : (app.config.host ?? "localhost");
}

/** One of this app's domains, by host — never another app's. */
function ownedDomain(
  app: App,
  record: AppRecord,
  host: string,
): AppDomain | undefined {
  const domain = getDomain(app.db, host);
  return domain?.appId === record.id ? domain : undefined;
}

function view(
  runtime: AppsRuntime,
  record: AppRecord,
  domain: AppDomain,
): AppDomainView {
  return {
    host: domain.host,
    verified: domain.verifiedAt !== null,
    verifiedAt: domain.verifiedAt,
    checkedAt: domain.checkedAt,
    said: domain.said,
    records: recordsFor(
      domain.host,
      domain.token,
      runtime.hostFor(record.slug, domain.env),
    ),
  };
}

export function listAppDomains(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<AppDomainView[], DomainError> {
  const gate = admitted(app, actor, repo);
  if (!gate.ok) return gate;
  const runtime = serving(app);
  if (!runtime.ok) return runtime;
  return ok(
    listDomains(app.db, gate.value.record.id).map((domain) =>
      view(runtime.value, gate.value.record, domain),
    ),
  );
}

/** Add a domain; the answer carries the two records to publish. */
export function addAppDomain(
  app: App,
  actor: User | undefined,
  repo: Repo,
  host: string,
): Result<AppDomainView, DomainError | AddDomainError> {
  const gate = admitted(app, actor, repo);
  if (!gate.ok) return gate;
  const runtime = serving(app);
  if (!runtime.ok) return runtime;
  const { admin, record } = gate.value;
  const added = addDomain(
    app.db,
    { host, appId: record.id, createdBy: admin.id },
    {
      forgeHost: forgeHost(app),
      appHostSuffix: appHostSuffix(
        runtime.value.options.domain.toLowerCase().replace(/:\d+$/, ""),
      ),
    },
  );
  if (!added.ok) return added;
  app.bus.append({
    kind: "app.domain.added",
    repoId: repo.id,
    actorId: admin.id,
    payload: { host: added.value.host, slug: record.slug },
  });
  return ok(view(runtime.value, record, added.value));
}

/**
 * Look the proof up now. The first check that finds it verifies the domain
 * for good and says so on the bus; every check leaves its sentence.
 */
export async function checkAppDomain(
  app: App,
  actor: User | undefined,
  repo: Repo,
  host: string,
): Promise<Result<AppDomainView, DomainError | "no_such_domain">> {
  const gate = admitted(app, actor, repo);
  if (!gate.ok) return gate;
  const runtime = serving(app);
  if (!runtime.ok) return runtime;
  const { admin, record } = gate.value;
  const domain = ownedDomain(app, record, host);
  if (domain === undefined) return err("no_such_domain");
  const found = await checkDomain(
    domain.host,
    domain.token,
    runtime.value.hostFor(record.slug, domain.env),
    runtime.value.options.dns,
  );
  // A verified name is served, so its certificate is worth reading: a failed
  // renewal shows here instead of on the day it expires.
  const said = found.verified
    ? `${found.said} ${certificateSaid(
        await (runtime.value.options.certificate ?? ((h) => probeCertificate(h)))(
          domain.host,
        ),
        new Date(),
      )}`
    : found.said;
  const updated =
    recordCheck(app.db, domain.host, { verified: found.verified, said }) ??
    domain;
  if (found.verified && domain.verifiedAt === null) {
    app.bus.append({
      kind: "app.domain.verified",
      repoId: repo.id,
      actorId: admin.id,
      payload: { host: domain.host, slug: record.slug },
    });
  }
  return ok(view(runtime.value, record, updated));
}

/** Take a domain away. The forge stops answering there at once. */
export function removeAppDomain(
  app: App,
  actor: User | undefined,
  repo: Repo,
  host: string,
): Result<void, "not_found" | "no_such_domain"> {
  const gate = admitted(app, actor, repo);
  if (!gate.ok) return gate;
  const { admin, record } = gate.value;
  const domain = ownedDomain(app, record, host);
  if (domain === undefined || !removeDomain(app.db, domain.host))
    return err("no_such_domain");
  app.bus.append({
    kind: "app.domain.removed",
    repoId: repo.id,
    actorId: admin.id,
    payload: { host: domain.host, slug: record.slug },
  });
  return ok();
}
