/**
 * The site pages: home, sign in / sign up, new repository. Plain forms,
 * zero JavaScript, fast everywhere — a phone in the redwoods is the
 * reference device.
 */

import { crossOrigin, type Ctx } from "../../http/context.ts";
import { createRepo, listReposVisibleTo } from "../../core/repos.ts";
import { createSession, destroySession } from "../../core/sessions.ts";
import { countUsers, createUser, verifyPassword } from "../../core/users.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";

export function sessionCookie(value: string, expires: Date, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `forge_session=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}

export function home(ctx: Ctx): Response {
  const repos = listReposVisibleTo(ctx.app.db, ctx.auth.user);
  const body = html`
    ${when(
      !ctx.auth.user && repos.length === 0,
      () =>
        html`<div class="narrow center hero">
          <h1>forge</h1>
          <p class="muted">
            Your code, your machine. Git hosting that just works.
          </p>
          <a class="btn" data-variant="primary" href="/signup"
            >Create an account</a
          >
        </div>`,
    )}
    ${when(
      ctx.auth.user !== undefined || repos.length > 0,
      () =>
        html`<div class="page-head">
            <h1>Repositories</h1>
            <span class="spacer"></span>
            ${when(
              ctx.auth.user,
              () =>
                html`<a class="btn" data-size="sm" href="/new"
                  >New repository</a
                >`,
            )}
          </div>
          ${repos.length === 0
            ? html`<div class="card empty">
                No repositories yet — create the first one.
              </div>`
            : html`<div class="card">
                <ul class="list">
                  ${repos.map(
                    (repo) =>
                      html`<li>
                        <a class="row" href="/${repo.ownerName}/${repo.name}">
                          <span class="grow">
                            <strong>${repo.ownerName}/${repo.name}</strong>
                            ${when(
                              repo.description !== "",
                              () =>
                                html`<span class="muted small">
                                  — ${repo.description}</span
                                >`,
                            )}
                          </span>
                          <span class="badge">${repo.visibility}</span>
                        </a>
                      </li>`,
                  )}
                </ul>
              </div>`}`,
    )}
  `;
  return page({ title: "forge", user: ctx.auth.user, body });
}

function authForm(kind: "signin" | "signup", error?: string): Html {
  const other =
    kind === "signin"
      ? html`<a class="muted small" href="/signup">Need an account? Sign up</a>`
      : html`<a class="muted small" href="/signin"
          >Have an account? Sign in</a
        >`;
  return html`<div class="narrow">
    <h1>${kind === "signin" ? "Sign in" : "Create your account"}</h1>
    <form method="post" action="/${kind}">
      <label for="username">Username</label>
      <input
        class="input"
        id="username"
        name="username"
        autocomplete="username"
        required
        autofocus
      />
      ${when(
        kind === "signup",
        () =>
          html`<label for="email">Email</label>
            <input
              class="input"
              id="email"
              name="email"
              type="email"
              autocomplete="email"
              required
            />`,
      )}
      <label for="password">Password</label>
      <input
        class="input"
        id="password"
        name="password"
        type="password"
        autocomplete="${kind === "signin"
          ? "current-password"
          : "new-password"}"
        ${when(kind === "signup", () => html`minlength="10"`)}
        required
      />
      ${when(error, (message) => html`<p class="error-note">${message}</p>`)}
      <div class="form-actions">
        <button class="btn" data-variant="primary" type="submit">
          ${kind === "signin" ? "Sign in" : "Sign up"}
        </button>
        ${other}
      </div>
    </form>
  </div>`;
}

export function signinPage(ctx: Ctx): Response {
  return page({
    title: "Sign in",
    user: ctx.auth.user,
    body: authForm("signin"),
  });
}

export function signupPage(ctx: Ctx): Response {
  return page({
    title: "Sign up",
    user: ctx.auth.user,
    body: authForm("signup"),
  });
}

export async function signinSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const verified = await verifyPassword(
    ctx.app.db,
    field(form, "username"),
    field(form, "password"),
  );
  if (!verified.ok) {
    return page({
      title: "Sign in",
      user: undefined,
      body: authForm("signin", "That username and password don't match."),
    });
  }
  const session = createSession(ctx.app.db, verified.value.id);
  return redirect(
    "/",
    sessionCookie(session.token, session.expiresAt, ctx.url),
  );
}

export async function signupSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const isFirst = countUsers(ctx.app.db) === 0;
  const created = await createUser(ctx.app.db, {
    username: field(form, "username"),
    email: field(form, "email"),
    password: field(form, "password"),
    isAdmin: isFirst,
  });
  if (!created.ok) {
    const messages: Record<string, string> = {
      invalid_username: "Usernames are letters, digits, dots, dashes.",
      username_taken: "That username is taken.",
      email_taken: "That email already has an account.",
      weak_password: "Passwords need at least 10 characters.",
    };
    return page({
      title: "Sign up",
      user: undefined,
      body: authForm(
        "signup",
        messages[created.error] ?? "Something went wrong.",
      ),
    });
  }
  ctx.app.bus.append({ kind: "user.created", actorId: created.value.id });
  const session = createSession(ctx.app.db, created.value.id);
  return redirect(
    "/",
    sessionCookie(session.token, session.expiresAt, ctx.url),
  );
}

export function logoutSubmit(ctx: Ctx): Response {
  if (crossOrigin(ctx.request, ctx.url))
    return new Response("forbidden", { status: 403 });
  const cookie = ctx.request.headers.get("cookie") ?? "";
  const match = cookie.match(/forge_session=([^;]+)/);
  if (match) destroySession(ctx.app.db, match[1]!);
  return redirect("/", sessionCookie("", new Date(0), ctx.url));
}

export function newRepoPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return redirect("/signin");
  const body = html`<div class="narrow">
    <h1>New repository</h1>
    <form method="post" action="/new">
      <label for="name">Name</label>
      <input
        class="input"
        id="name"
        name="name"
        required
        autofocus
        pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
      />
      <label for="description"
        >Description <span class="muted">(optional)</span></label
      >
      <input class="input" id="description" name="description" />
      <label for="visibility">Visibility</label>
      <select class="input" id="visibility" name="visibility">
        <option value="private">Private</option>
        <option value="public">Public</option>
      </select>
      <div class="form-actions">
        <button class="btn" data-variant="primary" type="submit">
          Create repository
        </button>
      </div>
    </form>
  </div>`;
  return page({ title: "New repository", user: ctx.auth.user, body });
}

export async function newRepoSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return redirect("/signin");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const created = await createRepo(ctx.app.db, ctx.app.reposRoot, {
    ownerId: ctx.auth.user.id,
    name: field(form, "name"),
    visibility: form.get("visibility") === "public" ? "public" : "private",
    description: field(form, "description"),
  });
  if (!created.ok) {
    return page({
      title: "New repository",
      user: ctx.auth.user,
      body: html`<div class="narrow">
        <h1>New repository</h1>
        <p class="error-note">
          ${created.error === "name_taken"
            ? "You already have a repository by that name."
            : "That name won't work."}
        </p>
        <p><a class="btn" href="/new">Try again</a></p>
      </div>`,
    });
  }
  ctx.app.bus.append({
    kind: "repo.created",
    repoId: created.value.id,
    actorId: ctx.auth.user.id,
  });
  return redirect(`/${created.value.ownerName}/${created.value.name}`);
}
