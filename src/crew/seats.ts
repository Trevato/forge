/**
 * The team as three seats: planner, builder, reviewer. One place says who
 * fills each, what it does, and what will not happen while it is empty — the
 * crew card draws it and the MCP `crew` tool returns it, so a page and an
 * agent read the same facts.
 */

import type { Database } from "bun:sqlite";
import { listCrewRoles, type CrewRole } from "../core/agents.ts";
import type { Repo } from "../core/repos.ts";

export type Seat = {
  role: CrewRole;
  /** Usernames filling it. */
  by: string[];
  /** One plain line on what the seat does. */
  does: string;
  /** What will not happen while it is empty, as a clause after "No <role>:"; set only when empty. */
  without?: string;
  /** "filled", "warn" (empty, auto mode on) or "invite" (empty, auto mode off). */
  state: "filled" | "warn" | "invite";
};

export type Seats = { auto: boolean; mode: Repo["autonomy"]; seats: Seat[] };

const SEATS: { role: CrewRole; does: string; without: string }[] = [
  {
    role: "planner",
    does: "Turns your direction into issues, so there is always a next thing to build.",
    without: "your direction goes nowhere, only issues people write get built",
  },
  {
    role: "builder",
    does: "Picks up an issue, writes the change and opens a pull.",
    without: "nothing gets built",
  },
  {
    role: "reviewer",
    does: "Reads each pull and lands the good ones.",
    without: "agent pulls wait for you",
  },
];

/** `crewOff` is true while the crew is held off (a preview): nobody works, so an empty seat invites rather than warns. */
export function seatsOf(db: Database, repo: Repo, crewOff = false): Seats {
  const crew = listCrewRoles(db, repo.id);
  const auto = repo.autonomy !== "off" && !crewOff;
  return {
    auto,
    mode: repo.autonomy,
    seats: SEATS.map((p) => {
      const by = crew
        .filter((c) => c.role === p.role)
        .map((c) => c.agent.user.username);
      return by.length > 0
        ? { role: p.role, by, does: p.does, state: "filled" as const }
        : {
            role: p.role,
            by,
            does: p.does,
            without: p.without,
            state: auto ? ("warn" as const) : ("invite" as const),
          };
    }),
  };
}
