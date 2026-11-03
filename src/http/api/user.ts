/**
 * The signed-in account over the API: every `/api/v1/user…` route — the
 * profile, password and email verification, its orgs and SSH keys, origins
 * (connecting, OAuth, browsing live, mirroring and forking), pins, and what
 * is assigned to the caller. Moved out of `api.ts` (#7444), unchanged.
 */

import { contribute, forkOrigin } from "../../actions/contribute.ts";
import { CAPPED_WORDS } from "../../actions/mail.ts";
import { ORIGIN_UNREACHABLE } from "../../actions/origin_app_words.ts";
import { connectOrigin, connectRefusal, deleteOriginApp, disconnectOrigin, listOriginApps, listPinned, listRemoteRepos, listUserOrigins, mirrorJobFor, pinRepo, pollOAuthConnect, registerOriginApp, startMirrorJob, startOAuthConnect, syncOriginNow, unpinRepo } from "../../actions/origins.ts";
import { addSshKey, changePassword, deleteSshKey, updateProfile } from "../../actions/users.ts";
import { VERIFY_WORDS } from "../../actions/verify_words.ts";
import { resendVerification } from "../../actions/verify.ts";
import { NOTIFY_ERRORS, notifyHost, notifyUrlOf, setNotifyUrl } from "../../crew/notify.ts";
import { listAssignedTo } from "../../core/issues.ts";
import { nextStepsFor } from "../../core/next-steps.ts";
import { listKeys, publicKey } from "../../core/keys.ts";
import { listOrgsForUser } from "../../core/orgs.ts";
import { canRead, getReposByIds } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { mayView } from "../../core/sealed.ts";
import { emailVerified } from "../../core/verify.ts";
import type { Result } from "../../kernel/result.ts";
import { subscribe as subscribeJob } from "../../origins/jobs.ts";
import { sshCloneUrl } from "../../ssh/command.ts";
import { type RepoSource, type SourceError, sourceFor } from "../../view/source.ts";
import { connectMessage, contributeFailure, contributionJson, editFilesFrom, jobJson, keyedPage, keyedWindow, loadRepo, oauthCallbackUri, originFacts, originJson, remoteRepoJson } from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { clientAddress } from "../peer.ts";
import { apiError, body, json, notFound, publicProfile, publicUser, requireAccount, requireScope, respondAccess, str, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";
import { eventStream } from "../sse.ts";

/**
 * Where a live browse is reading from — the banner's facts. The origin's
 * credential and its id are ours; what a client gets is the forge, the name
 * there, the page there, and whether we already hold a mirror of it.
 */
function whereJson(source: RepoSource) {
  const where = source.where;
  if (where.kind === "local")
    return {
      source: "local" as const,
      repo: { owner: where.repo.ownerName, name: where.repo.name },
    };
  return {
    source: "origin" as const,
    origin: {
      id: where.origin.id,
      kind: where.origin.kind,
      webUrl: where.origin.webUrl,
      login: where.origin.login,
    },
    fullName: where.fullName,
    htmlUrl: where.htmlUrl,
    mirroredAs:
      where.mirroredAs === undefined
        ? null
        : { owner: where.mirroredAs.ownerName, name: where.mirroredAs.name },
  };
}

/**
 * A live read that did not happen. `not_found` keeps its ambiguity; the rest
 * name which side said no, so a client can tell "come back later" from
 * "reconnect this origin".
 */
function sourceFailure(error: SourceError): Response {
  switch (error) {
    case "not_found":
      return notFound();
    case "rate_limited":
      return apiError(
        "rate_limited",
        429,
        "the origin is rate-limiting us; try again shortly",
      );
    case "unauthorized":
      return apiError(
        "origin_unauthorized",
        502,
        "the origin refused this forge's credential; reconnect it",
      );
    case "too_large":
      return apiError("too_large", 413, "that is too large to read here");
    case "unreachable":
      return apiError(
        "origin_unreachable",
        502,
        ORIGIN_UNREACHABLE,
      );
  }
}

export function userRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/user", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const me = ctx.auth.user;
    if (!me) return unauthorized();
    const verified = timePhase(ctx.request, "user", () => emailVerified(ctx.app.db, me.id));
    return timePhase(ctx.request, "render", () => json({ ...publicUser(me), emailVerified: verified }));
  });

  // Another verification link for the signed-in account; rate limited.
  router.add("POST", "/api/v1/user/email/verify", async (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    const sent = await resendVerification(ctx.app, ctx.auth.user);
    if (sent.ok)
      return json({ outcome: sent.value }, sent.value === "sent" ? 202 : 200);
    if (sent.error === "unauthorized") return unauthorized();
    if (sent.error === "too_soon")
      return apiError("too_soon", 429, VERIFY_WORDS.too_soon);
    if (sent.error === "no_mail")
      return apiError("no_mail", 503, VERIFY_WORDS.no_mail);
    if (sent.error === "capped")
      return apiError("capped", 429, CAPPED_WORDS);
    return apiError("failed", 502, VERIFY_WORDS.failed);
  });

  router.add("PATCH", "/api/v1/user", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    if (
      input.commitEmail !== undefined &&
      input.commitEmail !== "noreply" &&
      input.commitEmail !== "account"
    )
      return json({ error: "invalid_commit_email" }, 422);
    const updated = updateProfile(ctx.app, ctx.auth.user, {
      ...(typeof input.displayName === "string"
        ? { displayName: input.displayName }
        : {}),
      ...(typeof input.email === "string" ? { email: input.email } : {}),
      ...(input.commitEmail === "noreply" || input.commitEmail === "account"
        ? { commitEmail: input.commitEmail }
        : {}),
    });
    if (!updated.ok) return respondAccess(updated.error, 422);
    return json(publicUser(updated.value));
  });

  router.add("POST", "/api/v1/user/password", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const changed = await changePassword(ctx.app, ctx.auth.user, {
      current: str(input.current),
      next: str(input.next),
      source: clientAddress(ctx.request),
    });
    if (!changed.ok)
      return respondAccess(
        changed.error,
        changed.error === "bad_credentials"
          ? 403
          : changed.error === "throttled"
            ? 429
            : 422,
      );
    return json({}, 200);
  });

  router.add("GET", "/api/v1/user/orgs", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    if (!ctx.auth.user) return unauthorized();
    const user = ctx.auth.user;
    const window = keyedWindow(ctx);
    if (window instanceof Response) return window;
    const orgs = timePhase(ctx.request, "orgs", () =>
      listOrgsForUser(ctx.app.db, user.id).map(publicProfile),
    );
    return timePhase(ctx.request, "render", () => json(keyedPage(orgs, (o) => o.username, window)));
  });

  // SSH keys — what the SSH listener authenticates against. Public keys are
  // public, so the list returns them whole.
  router.add("GET", "/api/v1/user/keys", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const user = ctx.auth.user;
    if (!user) return unauthorized();
    const window = keyedWindow(ctx);
    if (window instanceof Response) return window;
    const keys = timePhase(ctx.request, "keys", () => listKeys(ctx.app.db, user.id));
    return timePhase(ctx.request, "render", () => json(keyedPage(keys.map(publicKey), (k) => k.id, window)));
  });
  router.add("POST", "/api/v1/user/keys", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const input = await body(ctx.request);
    const added = addSshKey(ctx.app, ctx.auth.user, {
      name: str(input.name),
      key: str(input.key),
    });
    if (!added.ok) return respondAccess(added.error, 422);
    return json(publicKey(added.value), 201);
  });
  router.add("DELETE", "/api/v1/user/keys/:id", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const removed = deleteSshKey(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!removed.ok) return respondAccess(removed.error, 422);
    return new Response(null, { status: 204 });
  });

  // The phone notify URL: a person's, and only its host is ever answered.
  const notifyState = (ctx: Ctx, userId: string) => {
    const host = notifyHost(notifyUrlOf(ctx.app.db, userId));
    return json({ set: host !== undefined, host: host ?? null });
  };
  router.add("GET", "/api/v1/user/notify", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const user = ctx.auth.user;
    if (!user) return unauthorized();
    if (user.kind === "agent") return apiError("forbidden", 403, "a notify URL is a person's, not an agent's");
    return notifyState(ctx, user.id);
  });
  router.add("PUT", "/api/v1/user/notify", async (ctx) => {
    const user = ctx.auth.user;
    if (user?.kind === "agent") return apiError("forbidden", 403, "a notify URL is a person's, not an agent's");
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const input = await body(ctx.request);
    if (typeof input.url !== "string") return apiError("invalid", 422, "send url as text, or empty to turn it off");
    const saved = setNotifyUrl(ctx.app.db, user!.id, input.url);
    if (!saved.ok) return apiError("invalid_url", 422, NOTIFY_ERRORS[saved.error]);
    ctx.app.bus.append({ kind: "account.notify_set", actorId: user!.id });
    return notifyState(ctx, user!.id);
  });

  // ── origins ──────────────────────────────────────────────────────────
  //
  // An origin holds a credential for another forge, so every route here is
  // gated on the *account* — a same-origin session, the password, or an
  // explicit `admin` token. A leaked `rw` token must never be able to
  // enumerate, connect, or spend somebody's GitHub access.

  /** The callback URL this forge tells an OAuth app to come back to. */
  const callbackUri = (ctx: Ctx): string =>
    oauthCallbackUri(ctx.url, ctx.app.config.host);

  router.add("GET", "/api/v1/user/origins", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const origins = timePhase(ctx.request, "origins", () => listUserOrigins(ctx.app, ctx.auth.user!).map(originJson));
    return timePhase(ctx.request, "render", () => json(origins));
  });

  router.add("POST", "/api/v1/user/origins", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const kind = str(input.kind);
    const connected = await connectOrigin(ctx.app, ctx.auth.user, {
      host: str(input.host) || kind,
      ...(kind === "github" || kind === "forgejo" || kind === "gitea"
        ? { kind }
        : {}),
      token: str(input.token),
    });
    if (!connected.ok) {
      // A refusal that names its own reason (a missing scope) keeps it;
      // every other code has its sentence here.
      const refused = connectRefusal(connected.error);
      return apiError(
        refused.code,
        refused.code === "rate_limited" ? 429 : 422,
        refused.message ?? connectMessage(refused.code),
      );
    }
    // The frozen mirrors connecting this account brought back, and the ones
    // it could not, each with its reason.
    return json(
      {
        ...originJson(connected.value),
        reattached: connected.value.reattached,
      },
      201,
    );
  });

  // OAuth: one start route for both flows, because which flow you get is a
  // property of the forge (device on GitHub, code+PKCE on Forgejo) and not
  // something a client should have to know.
  router.add("POST", "/api/v1/user/origins/oauth", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const kind = str(input.kind);
    const started = await startOAuthConnect(ctx.app, ctx.auth.user, {
      host: str(input.host) || kind,
      ...(kind === "github" || kind === "forgejo" || kind === "gitea"
        ? { kind }
        : {}),
      redirectUri: callbackUri(ctx),
    });
    if (!started.ok)
      return apiError(
        started.error.error,
        started.error.error === "rate_limited" ? 429 : 422,
        started.error.message,
      );
    return json(started.value, 201);
  });

  router.add("GET", "/api/v1/user/origins/oauth/:id", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const status = await timePhaseAsync(ctx.request, "origin", () =>
      pollOAuthConnect(ctx.app, ctx.auth.user, ctx.params.id!),
    );
    if (!status.ok) return respondAccess(status.error, 404);
    return json(status.value);
  });

  // Registered OAuth applications. Every Forgejo instance needs its own, so
  // this is a per-user, per-host registration; GitHub can fall back to one
  // the operator configured for the whole forge.
  router.add("GET", "/api/v1/user/origin-apps", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const apps = timePhase(ctx.request, "apps", () => listOriginApps(ctx.app, ctx.auth.user!));
    return timePhase(ctx.request, "render", () => json(apps));
  });

  router.add("POST", "/api/v1/user/origin-apps", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const kind = str(input.kind);
    const saved = await registerOriginApp(ctx.app, ctx.auth.user, {
      host: str(input.host) || kind,
      ...(kind === "github" || kind === "forgejo" || kind === "gitea"
        ? { kind }
        : {}),
      clientId: str(input.clientId),
      ...(typeof input.clientSecret === "string"
        ? { clientSecret: input.clientSecret }
        : {}),
    });
    if (!saved.ok)
      return apiError(saved.error, 422, connectMessage(saved.error));
    return json(saved.value, 201);
  });

  router.add("DELETE", "/api/v1/user/origin-apps/:id", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const removed = deleteOriginApp(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!removed.ok) return respondAccess(removed.error, 404);
    return new Response(null, { status: 204 });
  });

  router.add("DELETE", "/api/v1/user/origins/:id", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const gone = await disconnectOrigin(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!gone.ok) return respondAccess(gone.error, 404);
    return json(gone.value);
  });

  router.add("POST", "/api/v1/user/origins/:id/sync", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const synced = await syncOriginNow(ctx.app, ctx.auth.user, ctx.params.id!);
    if (!synced.ok) return respondAccess(synced.error, 404);
    return json(synced.value);
  });

  router.add("GET", "/api/v1/user/origins/:id/repos", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const listed = await timePhaseAsync(ctx.request, "origin", () =>
      listRemoteRepos(
        ctx.app,
        ctx.auth.user,
        ctx.params.id!,
        ctx.url.searchParams.get("refresh") === "1",
      ),
    );
    if (!listed.ok)
      return listed.error === "unreachable"
        ? apiError("origin_unreachable", 502, ORIGIN_UNREACHABLE)
        : respondAccess(listed.error, 404);
    return timePhase(ctx.request, "render", () =>
      json(listed.value.map((row) => remoteRepoJson(ctx, row))),
    );
  });

  // ── browsing an origin, live ─────────────────────────────────────────
  //
  // Reading a repository the origin holds and we do not: the same shapes the
  // local read routes return, so a client renders one screen either way.
  // Everything runs through `sourceFor`, which is where the rule lives that
  // only the person who connected an origin may browse through it — the
  // request spends their credential on another forge.

  const browse = (ctx: Ctx): RepoSource | Response => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const source = sourceFor(ctx.app, ctx.auth.user, {
      originId: ctx.params.id!,
      fullName: `${ctx.params.owner!}/${ctx.params.name!}`,
    });
    return source.ok ? source.value : sourceFailure(source.error);
  };

  /** Run one read against a live source and shape whatever comes back. */
  const read = async <T>(
    ctx: Ctx,
    run: (source: RepoSource) => Promise<Result<T, SourceError>>,
    shape: (value: T) => Response,
  ): Promise<Response> => {
    const source = browse(ctx);
    if (source instanceof Response) return source;
    const result = await timePhaseAsync(ctx.request, "origin", () => run(source));
    return result.ok
      ? timePhase(ctx.request, "render", () => shape(result.value))
      : sourceFailure(result.error);
  };

  const BROWSE = "/api/v1/user/origins/:id/browse/:owner/:name";

  // The landing read: what a repo page needs before it needs anything else.
  router.add("GET", BROWSE, async (ctx) => {
    const source = browse(ctx);
    if (source instanceof Response) return source;
    const facts = await timePhaseAsync(ctx.request, "origin", () => source.describe());
    if (!facts.ok) return sourceFailure(facts.error);
    const [branches, readme] = await timePhaseAsync(ctx.request, "origin", () =>
      Promise.all([source.branches(), source.readme(facts.value.defaultBranch)]),
    );
    return timePhase(ctx.request, "render", () =>
      json({
        ...whereJson(source),
        capabilities: source.capabilities,
        facts: facts.value,
        branches: branches.ok ? branches.value : [],
        readme: readme.ok ? readme.value : null,
      }),
    );
  });

  router.add("GET", `${BROWSE}/branches`, (ctx) =>
    read(ctx, (s) => s.branches(), json),
  );
  router.add("GET", `${BROWSE}/tags`, (ctx) =>
    read(ctx, (s) => s.tags(), json),
  );
  router.add("GET", `${BROWSE}/labels`, (ctx) =>
    read(ctx, (s) => s.labels(), json),
  );
  router.add("GET", `${BROWSE}/paths/:ref`, (ctx) =>
    read(ctx, (s) => s.paths(ctx.params.ref!), json),
  );

  const treeHandler = (ctx: Ctx): Promise<Response> => {
    const ref = ctx.params.ref!;
    const path = ctx.params.path ?? "";
    return read(
      ctx,
      (s) => s.tree(ref, path),
      (entries) => json({ type: "dir", ref, path, entries }),
    );
  };
  router.add("GET", `${BROWSE}/tree/:ref`, treeHandler);
  router.add("GET", `${BROWSE}/tree/:ref/*path`, treeHandler);

  // Shaped exactly like the local contents endpoint, down to the 413.
  router.add("GET", `${BROWSE}/blob/:ref/*path`, (ctx) => {
    const ref = ctx.params.ref!;
    const path = ctx.params.path ?? "";
    return read(
      ctx,
      (s) => s.blob(ref, path),
      (blob) => {
        if (blob.kind === "too_large")
          return json({ type: "file", tooLarge: true, size: blob.size }, 413);
        const binary = blob.kind === "binary";
        return json({
          type: "file",
          ref,
          path,
          size: blob.size,
          encoding: binary ? "base64" : "utf-8",
          content: binary
            ? Buffer.from(blob.body).toString("base64")
            : new TextDecoder().decode(blob.body),
        });
      },
    );
  });

  router.add("GET", `${BROWSE}/commits`, async (ctx) => {
    const source = browse(ctx);
    if (source instanceof Response) return source;
    // Only ask what the default branch is when the caller did not say — on
    // a live source that question is a request to another forge.
    let ref = ctx.url.searchParams.get("ref") ?? "";
    if (ref === "") {
      const facts = await timePhaseAsync(ctx.request, "origin", () => source.describe());
      if (!facts.ok) return sourceFailure(facts.error);
      ref = facts.value.defaultBranch || "HEAD";
    }
    const cursor = ctx.url.searchParams.get("cursor") ?? undefined;
    const page = await timePhaseAsync(ctx.request, "origin", () => source.commits(ref, cursor));
    if (!page.ok) return sourceFailure(page.error);
    return timePhase(ctx.request, "render", () =>
      json({ items: page.value.items, next_cursor: page.value.next }),
    );
  });

  router.add("GET", `${BROWSE}/commits/:oid`, (ctx) => {
    const oid = ctx.params.oid!;
    return read(
      ctx,
      (s) => s.commit(oid),
      ({ commit, diff }) => json({ ...commit, diff }),
    );
  });

  const conversations = (kind: "issue" | "pull") => async (ctx: Ctx) => {
    const q = ctx.url.searchParams;
    const stateParam = q.get("state");
    const label = q.get("label");
    const author = q.get("author");
    const search = q.get("q");
    const cursor = q.get("cursor");
    return read(
      ctx,
      (s) =>
        s.issues({
          kind,
          state:
            stateParam === "closed" || stateParam === "all"
              ? stateParam
              : "open",
          ...(label ? { label } : {}),
          ...(author ? { author } : {}),
          ...(search ? { query: search } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      (page) => json({ items: page.items, next_cursor: page.next }),
    );
  };
  router.add("GET", `${BROWSE}/issues`, conversations("issue"));
  router.add("GET", `${BROWSE}/pulls`, conversations("pull"));

  const conversation = (ctx: Ctx): Promise<Response> => {
    const number = Number(ctx.params.number);
    return read(
      ctx,
      (s) => s.issue(number),
      (detail) =>
        json({
          ...detail.issue,
          body: detail.body,
          comments: detail.comments,
          pull: detail.pull,
        }),
    );
  };
  router.add("GET", `${BROWSE}/issues/:number`, conversation);
  router.add("GET", `${BROWSE}/pulls/:number`, conversation);

  // ── mirroring, as a job ──────────────────────────────────────────────
  //
  // 202, not 201: the repository does not exist yet. What comes back is
  // something to watch — poll it, or take the stream and render the stages.

  router.add("POST", "/api/v1/user/origins/:id/mirror", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const started = startMirrorJob(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      str(input.fullName),
      str(input.name) || undefined,
    );
    if (!started.ok) return respondAccess(started.error, 404);
    return json({ job: jobJson(ctx, started.value) }, 202);
  });

  // Fork at the origin. 202, like mirroring: the fork is asynchronous on
  // GitHub, and the local copy of it is a job to watch.
  router.add("POST", "/api/v1/user/origins/:id/fork", async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const forked = await forkOrigin(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      str(input.fullName),
    );
    if (!forked.ok) return contributeFailure(forked.error);
    return json(
      {
        remote: forked.value.remote,
        existed: forked.value.existed,
        job:
          forked.value.job === undefined
            ? null
            : jobJson(ctx, forked.value.job),
        mirroredAs:
          forked.value.mirror === undefined
            ? null
            : {
                owner: forked.value.mirror.ownerName,
                name: forked.value.mirror.name,
              },
      },
      202,
    );
  });

  // Contribute to a repository we are only *browsing* — the fork flow
  // straight from the picker, with no mirror of the upstream first.
  router.add("POST", `${BROWSE}/contribute`, async (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const input = await body(ctx.request);
    const result = await contribute(ctx.app, ctx.auth.user, {
      originId: ctx.params.id!,
      fullName: `${ctx.params.owner!}/${ctx.params.name!}`,
      branch: str(input.branch),
      ...(str(input.base) === "" ? {} : { base: str(input.base) }),
      ...(str(input.message) === "" ? {} : { message: str(input.message) }),
      files: editFilesFrom(input.files),
      ...(typeof input.openPull === "object" && input.openPull !== null
        ? {
            openPull: {
              title: str((input.openPull as Record<string, unknown>).title),
              body: str((input.openPull as Record<string, unknown>).body),
            },
          }
        : {}),
    });
    if (!result.ok) return contributeFailure(result.error);
    return json(contributionJson(ctx, result.value), 201);
  });

  router.add("GET", "/api/v1/user/origins/:id/mirror/:job", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const job = timePhase(ctx.request, "job", () =>
      mirrorJobFor(ctx.app, ctx.auth.user, ctx.params.id!, ctx.params.job!),
    );
    if (!job.ok) return respondAccess(job.error, 404);
    return timePhase(ctx.request, "render", () =>
      json({ job: jobJson(ctx, job.value) }),
    );
  });

  // The same job as a live stream, so a mirror can be watched rather than
  // polled. It ends itself the moment the job reaches a terminal stage.
  router.add("GET", "/api/v1/user/origins/:id/mirror/:job/stream", (ctx) => {
    const denied = requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const found = mirrorJobFor(
      ctx.app,
      ctx.auth.user,
      ctx.params.id!,
      ctx.params.job!,
    );
    if (!found.ok) return respondAccess(found.error, 404);
    return eventStream(ctx.app, ctx.request, (emit, close) =>
      subscribeJob(found.value.id, (job) => {
        emit(`mirror.${job.stage}`, jobJson(ctx, job), job.id);
        if (job.stage === "done" || job.stage === "failed") close();
      }),
    );
  });

  // ── pins ─────────────────────────────────────────────────────────────

  // The local client clones from this list, so each pin carries what a
  // clone needs: both URLs and where the repo came from.
  router.add("GET", "/api/v1/user/pins", (ctx) => {
    if (!ctx.auth.user) return unauthorized();
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const window = keyedWindow(ctx);
    if (window instanceof Response) return window;
    const user = ctx.auth.user;
    const { pins, repos } = timePhase(ctx.request, "pins", () => {
      const pins = listPinned(ctx.app, user);
      // One query for every pinned repo, not one per pin.
      const repos = getReposByIds(
        ctx.app.db,
        pins.map((pin) => pin.repoId),
      );
      return { pins, repos };
    });
    return timePhase(ctx.request, "render", () => {
      const items = pins.flatMap((pin) => {
        const repo = repos.get(pin.repoId);
        if (!repo) return [];
        const path = `${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}`;
        return [
          {
            repoId: repo.id,
            owner: repo.ownerName,
            name: repo.name,
            defaultBranch: repo.defaultBranch,
            cloneUrl: `${ctx.url.origin}/${path}.git`,
            sshUrl:
              sshCloneUrl(ctx.app, repo.ownerName, repo.name) ?? null,
            origin: originFacts(repo),
            pinnedAt: pin.createdAt,
          },
        ];
      });
      return json(keyedPage(items, (p) => `${p.owner}/${p.name}`, window));
    });
  });

  router.add("PUT", "/api/v1/user/pins/:owner/:name", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const pinned = pinRepo(ctx.app, ctx.auth.user, repo);
    if (!pinned.ok) return respondAccess(pinned.error, 404);
    return json({ pinned: true });
  });

  // What is on the caller: open issues and pulls assigned to them, anywhere.
  router.add("GET", "/api/v1/user/assigned", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const user = ctx.auth.user!;
    const items = timePhase(ctx.request, "assigned", () => {
      const issues = listAssignedTo(ctx.app.db, user.id);
      const repos = getReposByIds(
        ctx.app.db,
        issues.map((i) => i.repoId),
      );
      const out = [];
      for (const issue of issues) {
        const repo = repos.get(issue.repoId);
        if (!repo || !canRead(ctx.app.db, repo, user)) continue;
        if (!mayView(ctx.app.db, repo, issue, user)) continue;
        out.push({
          ...issue,
          repo: { owner: repo.ownerName, name: repo.name },
        });
      }
      return out;
    });
    // Tagged by its own bytes: a retitle, a close or an assignment changes
    // them, and the viewer's own list is all they cover. Only reached with
    // a session or a token of `ro` or more.
    return timePhase(ctx.request, "render", () => {
      const text = JSON.stringify({ items, next_cursor: null });
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
  });

  // The first three steps on a spawned forge, as MCP `next_steps`: empty
  // elsewhere, for an agent, and for anyone but the forge's owner.
  router.add("GET", "/api/v1/user/next-steps", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const steps = await nextStepsFor(ctx.app, ctx.auth.user);
    return json({ steps: steps ?? [] });
  });

  router.add("DELETE", "/api/v1/user/pins/:owner/:name", (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const removed = unpinRepo(ctx.app, ctx.auth.user, repo);
    if (!removed.ok) return respondAccess(removed.error, 404);
    return new Response(null, { status: 204 });
  });
}
