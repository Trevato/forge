/**
 * One connect in flight: the page a device grant or a code flow waits on,
 * and the poll it submits. An OAuth flow is a row, not a page state — the
 * browser can be closed, the phone can do the typing, and coming back to
 * `/settings/origins/flows/:id` resumes exactly where it was.
 *
 * `origins.ts` starts the flow and owns the helpers both pages share; this
 * file only carries it to its end.
 */

import { pollOAuthConnect } from "../../actions/origins.ts";
import { getFlowFor } from "../../origins/oauth.ts";
import type { Ctx } from "../../http/context.ts";
import { forgeBaseUrl } from "../../http/api.ts";
import { qrEncode, qrSvg } from "../../design/qr.ts";
import { readForm } from "../form.ts";
import { html, raw, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { pollJs } from "../client.ts";
import { btn, card, icon, row } from "../ui.ts";
import {
  accountOnly,
  hostLabel,
  notFoundNote,
  shell,
  thenOf,
  type Then,
} from "./origins.ts";

const thenQuery = (then: Then): string =>
  then === undefined ? "" : "then=migrate";

/**
 * GET /settings/origins/flows/:id — a connect in progress.
 *
 * The device grant shows the code and where to type it; the code flow shows
 * one link to the instance. Both work with no JavaScript: the page carries a
 * "check again" form, and reloading it re-polls. With script, the same form
 * is submitted for you every couple of seconds.
 */
export function originFlowPage(ctx: Ctx): Response {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const flow = getFlowFor(ctx.app.db, ctx.auth.user!.id, ctx.params.id ?? "");
  if (!flow) return shell(ctx, notFoundNote(), 404);
  const then = thenOf(ctx.url.searchParams.get("then"));

  if (flow.status === "done")
    return redirect(`${then ?? "/settings/origins"}?connected=1`);
  if (flow.status === "failed")
    return redirect(
      `/settings/origins?error=${encodeURIComponent(flow.detail.slice(0, 120))}`,
    );

  const pollAction = `/settings/origins/flows/${flow.id}/poll${then === undefined ? "" : `?${thenQuery(then)}`}`;
  const authorize =
    flow.flow === "code"
      ? authorizeLink(ctx.url.searchParams.get("to") ?? "", flow.webUrl)
      : undefined;
  const base = forgeBaseUrl(ctx.url, ctx.app.config.host);
  const shortLink =
    base === "" || flow.shortCode === "" ? "" : `${base}/go/${flow.shortCode}`;
  const body =
    flow.flow === "device"
      ? html`${card(
          html`<p class="muted small">
              Type this code at
              <a href="${flow.verificationUri}" rel="noreferrer noopener"
                >${flow.verificationUri}</a
              >. Any device with a browser will do — this page waits.
            </p>
            <div class="bar">
              <p class="device-code" id="device-code">${flow.userCode}</p>
              ${copyBtn("device-code", "Copy the code")}
            </div>
            ${handoff(flow.verificationUri, shortLink)}`,
          {
            head: html`${icon("github")}
              <h2>Enter this code</h2>`,
          },
        )}`
      : html`${card(
          authorize === undefined
            ? html`<p>
                  This connect cannot be continued from here — the authorization
                  link was lost. Start it again from Origins.
                </p>
                <div class="bar mt">
                  ${btn("Back to origins", {
                    href: "/settings/origins",
                    variant: "primary",
                  })}
                </div>`
            : html`<p>
                  Continue to
                  <span class="mono">${hostLabel(flow.webUrl)}</span> and
                  approve the application. You will come straight back here.
                </p>
                ${handoff(authorize, shortLink, "Continue to the instance")}`,
          {
            head: html`${icon("forgejo")}
              <h2>Authorize on the instance</h2>`,
          },
        )}`;

  const waiting = html`<form
    class="bar mt"
    method="post"
    action="${pollAction}"
    data-poll="${flow.flow === "device"
      ? String(Math.max(1, flow.intervalSecs))
      : "0"}"
  >
    <span class="muted small"
      >Waiting for you to authorize
      ${flow.flow === "device"
        ? "on the other device"
        : "on the instance"}…</span
    >
    <span class="spacer"></span>
    ${btn("Check again", { size: "sm", variant: "outline", icon: "sync" })}
    ${btn("Cancel", {
      href: "/settings/origins",
      size: "sm",
      variant: "ghost",
    })}
  </form>`;

  return page({
    ctx,
    title: "Connecting an origin",
    body: html`<div class="page-head"><h1>Connecting an origin</h1></div>
      <div class="narrow-wide">
        ${body}${waiting}
        <p class="muted small mt">
          No JavaScript? Refresh this page to check again — the reload re-polls.
        </p>
      </div>`,
    scriptJs: pollJs,
  });
}

/** The copy affordance: an icon button that is inert without a script, and
 * sits beside text that stays selectable either way. */
function copyBtn(target: string, label: string): Html {
  return html`<button
    class="btn btn-icon js-only"
    data-size="sm"
    type="button"
    data-copy="${target}"
    aria-label="${label}"
    title="Copy"
  >
    ${icon("copy")}
  </button>`;
}

/**
 * Getting the person to the other device: a QR code they point a camera at,
 * the short link they could type instead, the full URL for a browser that is
 * already here, and one button that opens it.
 *
 * The QR carries the short link when the forge knows its own address and the
 * long URL otherwise — the shorter the payload, the coarser the modules and
 * the further away a phone can read it.
 */
function handoff(url: string, shortLink: string, openLabel?: string): Html {
  const payload = shortLink === "" ? url : shortLink;
  const code = qrEncode(payload);
  return html`<div class="bar mt">
      ${code.ok
        ? raw(
            qrSvg(code.value, {
              title: "Scan to open the link",
              scale: qrScale(code.value.modules.length),
            }),
          )
        : null}
    </div>
    <ul class="list setting-list mt">
      ${shortLink === ""
        ? null
        : row({
            title: "Or open this on a phone:",
            meta: html`<span class="mono" id="flow-short">${shortLink}</span>`,
            trail: copyBtn("flow-short", "Copy the short link"),
          })}
      ${row({
        title: "The full link:",
        meta: html`<span class="mono small" id="flow-url">${url}</span>`,
        trail: copyBtn("flow-url", "Copy the link"),
      })}
    </ul>
    <div class="bar mt">
      ${btn(openLabel ?? "Open the verification page", {
        href: url,
        variant: "primary",
        icon: "external",
        external: true,
      })}
    </div>`;
}

/**
 * The module size that keeps the code at most 200 px square: the encoder sizes
 * the SVG from it, so a long URL (more modules) must not make a code wider
 * than a 360 px phone can hold beside the page's padding.
 */
function qrScale(modules: number): number {
  return Math.max(1, Math.min(4, Math.floor(200 / modules)));
}

/**
 * The authorize URL for a code flow, checked before it becomes a link.
 *
 * It arrives on the query string because the flow row stores a *device*
 * flow's verification URI and nothing for a code flow. A crafted link could
 * therefore reach this page, so the URL is accepted only when it points at
 * the same instance the flow already names and carries a PKCE challenge —
 * the worst a forged one can do is send you to another page on the forge you
 * asked to connect.
 */
function authorizeLink(raw: string, webUrl: string): string | undefined {
  const url = URL.parse(raw);
  const instance = URL.parse(webUrl);
  if (!url || !instance) return undefined;
  if (url.origin !== instance.origin) return undefined;
  if (url.searchParams.get("code_challenge") === null) return undefined;
  return url.toString();
}

/**
 * POST /settings/origins/flows/:id/poll — ask the origin once, on the user's
 * behalf. The forge does the polling, so a browser (or a phone) only ever
 * asks "has it happened yet?" and a token never crosses back to a surface.
 *
 * Answers JSON to a client that asked for it and a redirect to everyone
 * else, so the same route serves the enhancement and the plain form.
 */
export async function originFlowPoll(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const polled = await pollOAuthConnect(
    ctx.app,
    ctx.auth.user,
    ctx.params.id ?? "",
  );
  const wantsJson = (ctx.request.headers.get("accept") ?? "").includes(
    "application/json",
  );
  if (!polled.ok) {
    return wantsJson
      ? Response.json(
          { status: "failed", detail: "not found" },
          { status: 404 },
        )
      : redirect("/settings/origins?error=state");
  }
  const { status, detail } = polled.value;
  const then = thenOf(ctx.url.searchParams.get("then"));
  if (wantsJson) return Response.json({ status, detail });
  if (status === "done")
    return redirect(`${then ?? "/settings/origins"}?connected=1`);
  if (status === "failed")
    return redirect(
      `/settings/origins?error=${encodeURIComponent(detail.slice(0, 120))}`,
    );
  return redirect(
    `/settings/origins/flows/${ctx.params.id ?? ""}${then === undefined ? "" : `?${thenQuery(then)}`}`,
  );
}
