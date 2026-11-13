/**
 * Calling a tool an absorbed app declares (`apps/feature_tools.ts`). The rules:
 * only an absorbed app's declared tools are called; a reader may call a tool
 * that only reads, a writer one that changes things, and a writer's call is
 * planned before it is made; the app is reached over
 * loopback at its production port and nothing else is asked of it.
 */

import type { App } from "../app.ts";
import { runRecorded } from "../apps/feature_schedule.ts";
import { callTool } from "../apps/feature_tools.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { getAbsorbed } from "../core/features.ts";
import { canWrite } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { declaredFeature, readable } from "./features.ts";

export type ToolError = "not_found" | "not_absorbed" | "no_such_tool" | "forbidden" | "not_running" | "failed";

export async function callFeatureTool(
  app: App,
  actor: User | undefined,
  slug: string,
  tool: string,
  args: Record<string, unknown>,
  dryRun: boolean,
): Promise<Result<{ planned: string } | { answer: unknown }, { error: ToolError; message: string }>> {
  const refuse = (error: ToolError, message: string) => err({ error, message });
  const found = readable(app, actor, slug);
  if (found === undefined) return refuse("not_found", "No such app.");
  if (getAbsorbed(app.db, found.record.id) === undefined) return refuse("not_absorbed", "The app is not absorbed.");
  const declared = await declaredFeature(app, found.repo);
  const spec = declared.ok ? declared.value?.tools.find((t) => t.name === tool) : undefined;
  if (spec === undefined) return refuse("no_such_tool", `The app declares no tool ${tool}.`);
  if (spec.writes && !canWrite(app.db, found.repo, actor)) return refuse("forbidden", "A tool that changes things is for someone who can write this app.");
  const port = appsRuntime(app)?.envStatus(found.record, "production")?.port;
  if (port === undefined) return refuse("not_running", "The app is not running.");
  // A plan is told only once the call could be made: allowed, absorbed, running.
  if (spec.writes && dryRun) return ok({ planned: `Would call ${tool} on ${found.record.slug}: ${spec.description} Send dryRun: false to do it.` });
  // A tool the schedule names is the same recorded run as the schedule's and the page's, so it
  // shows in the tool's line and history; any other tool (a read like `latest`) is called and not
  // recorded.
  const scheduled = declared.ok && declared.value?.schedule.some((e) => e.tool === tool) === true;
  if (!scheduled) {
    const answer = await callTool(port, tool, args);
    return answer.ok ? ok({ answer: answer.value }) : refuse("failed", answer.error);
  }
  const ran = await runRecorded(app.db, found.record.id, tool, port, args, "mcp");
  if (!ran.ran) return refuse("failed", `${tool} is already running.`);
  return ran.answer.ok ? ok({ answer: ran.answer.value }) : refuse("failed", ran.answer.error);
}
