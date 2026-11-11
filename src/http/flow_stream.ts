/**
 * GET /settings/origins/flows/:id/stream: a device-code connect, waited on by
 * the forge instead of by the page. The provider sets the cadence and sends no
 * event, so the forge asks it on that cadence, here, and tells the browser once:
 * `flow.settled` with the status, after which the stream ends and the page
 * re-reads itself. The page never loops.
 */

import { pollOAuthConnect } from "../actions/origins.ts";
import { getFlowFor } from "../origins/oauth.ts";
import type { Ctx } from "./context.ts";
import { tryAgain } from "./respond.ts";
import { eventStream } from "./sse.ts";
import { notFoundPage } from "../web/chrome.ts";

/** A tab may wait this long; the page re-reads itself when the stream ends. */
const MAX_WAIT_MS = 15 * 60_000;
/** Tabs on one flow beyond this are refused: one person has no use for more. */
const MAX_TABS_PER_FLOW = 8;

type Settled = { status: string };
type Poller = { listeners: Set<(s: Settled) => void>; timer?: ReturnType<typeof setTimeout> };

/** One poller per flow, shared by every tab that waits on it: the provider is asked once per interval. */
const pollers = new Map<string, Poller>();

function subscribe(ctx: Ctx, flowId: string, firstDelaySecs: number, onSettled: (s: Settled) => void): (() => void) | null {
  const user = ctx.auth.user!;
  let poller = pollers.get(flowId);
  if (poller && poller.listeners.size >= MAX_TABS_PER_FLOW) return null;
  if (!poller) {
    const made: Poller = { listeners: new Set() };
    poller = made;
    pollers.set(flowId, made);
    const finish = (s: Settled): void => {
      pollers.delete(flowId);
      if (made.timer) clearTimeout(made.timer);
      for (const listener of [...made.listeners]) listener(s);
    };
    const step = async (): Promise<void> => {
      if (pollers.get(flowId) !== made) return;
      try {
        const polled = await pollOAuthConnect(ctx.app, user, flowId);
        if (pollers.get(flowId) !== made) return;
        if (!polled.ok || polled.value.status !== "pending") return finish({ status: polled.ok ? polled.value.status : "failed" });
        made.timer = setTimeout(() => void step(), Math.max(1, polled.value.intervalSecs) * 1000);
      } catch {
        finish({ status: "failed" });
      }
    };
    made.timer = setTimeout(() => void step(), Math.max(1, firstDelaySecs) * 1000);
  }
  const mine = poller;
  mine.listeners.add(onSettled);
  return () => {
    mine.listeners.delete(onSettled);
    if (mine.listeners.size === 0 && pollers.get(flowId) === mine) {
      if (mine.timer) clearTimeout(mine.timer);
      pollers.delete(flowId);
    }
  };
}

export function originFlowStream(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return new Response("sign in first", { status: 401 });
  const flowId = ctx.params.id ?? "";
  const flow = getFlowFor(ctx.app.db, user.id, flowId);
  if (!flow) return notFoundPage(ctx);
  if ((pollers.get(flowId)?.listeners.size ?? 0) >= MAX_TABS_PER_FLOW) return tryAgain("too_many_tabs", 429, "Too many tabs are waiting on this flow.", 30);

  return eventStream(ctx.app, ctx.request, (emit, close) => {
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    const leave = subscribe(ctx, flowId, flow.intervalSecs, (settled) => {
      emit("flow.settled", settled);
      close();
    });
    lifetime = setTimeout(() => {
      emit("flow.settled", { status: "pending" });
      close();
    }, MAX_WAIT_MS);
    return () => {
      leave?.();
      clearTimeout(lifetime);
    };
  });
}
