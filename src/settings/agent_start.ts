/**
 * Whether an agent holding only the forge's URL may start here
 * (`POST /api/v1/start`, #10912): `open`, `code` (a start call must bring an
 * open invite link's token, spent with the account) or `off`. Stored in
 * `forge_setting` under `agent_start`; every change is kept with who and when.
 * Default `open` when nothing is stored.
 */
import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { writeSetting } from "./limits.ts";

export const AGENT_START_MODES = ["open", "code", "off"] as const;
export type AgentStartMode = (typeof AGENT_START_MODES)[number];
export const AGENT_START_DEFAULT: AgentStartMode = "open";

const STORE_KEY = "agent_start";

export function parseAgentStart(raw: unknown): Result<AgentStartMode, "invalid_agent_start"> {
  return typeof raw === "string" && (AGENT_START_MODES as readonly string[]).includes(raw)
    ? ok(raw as AgentStartMode)
    : err("invalid_agent_start");
}

export function getAgentStart(db: Database): AgentStartMode {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
    .get(STORE_KEY);
  if (row === null) return AGENT_START_DEFAULT;
  const parsed = parseAgentStart(row.value);
  return parsed.ok ? parsed.value : AGENT_START_DEFAULT;
}

/** Set the mode and keep the change; the same mode again keeps nothing. */
export function setAgentStart(db: Database, value: AgentStartMode, actorId: string): void {
  const from = getAgentStart(db);
  if (from === value) return;
  writeSetting(db, STORE_KEY, value, from, value, actorId);
}
