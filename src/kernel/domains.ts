/**
 * The forge's failure domains as data: what breaks, the words the forge
 * already says when it does (`says`: fragments copied from what
 * `kernel/vitals.ts` emits, each proved by `test/domains.test.ts`), the
 * minutes until it is back (estimates, not measurements), what the owner
 * does, and the drill that exercises it. A domain the forge has no words for
 * yet has an empty `says`; `docs/DOMAINS.md` is the same table for a person.
 */

export interface Domain {
  readonly key: string;
  readonly name: string;
  readonly breaks: string;
  /** Fragments of sentences the forge emits today; empty when it says nothing yet. */
  readonly says: readonly string[];
  readonly backMinutes: number;
  readonly owner: string;
  /** A drill's name, or why it cannot be drilled without harm. */
  readonly drill: { readonly name: string } | { readonly name: null; readonly why: string };
}

export const DOMAINS: readonly Domain[] = [
  {
    key: "compute",
    name: "Compute (the pod)",
    breaks: "Nothing answers until the pod is rescheduled.",
    says: [],
    backMinutes: 2,
    owner: "Wait for the platform to restart it; read the pod's events if it does not.",
    drill: { name: "kill-pod" },
  },
  {
    key: "state",
    name: "State (the volume)",
    breaks: "Writes fail once the volume fills; the data is lost with the volume.",
    says: ["Disk is nearly full:"],
    backMinutes: 60,
    owner: "Free or grow the volume; if it is gone, restore the newest snapshot (docs/RECOVERY.md).",
    drill: { name: null, why: "Filling or detaching the live volume would lose writes." },
  },
  {
    key: "snapshots",
    name: "The snapshot store",
    breaks: "Backups stop landing or cannot be read back; nothing live is affected.",
    says: ["The restore drill failed at"],
    backMinutes: 30,
    owner: "Fix the bucket or its keys, then run the restore drill again.",
    drill: { name: "restore-drill" },
  },
  {
    key: "edge",
    name: "The edge (tunnel and DNS)",
    breaks: "The forge runs but nobody outside can reach it.",
    says: [],
    backMinutes: 10,
    owner: "Restart the tunnel; check the DNS record.",
    drill: { name: null, why: "Cutting the tunnel cuts every person and agent off the forge." },
  },
  {
    key: "identity",
    name: "Identity",
    breaks: "Sign-in fails; sessions and tokens already issued may still work.",
    says: [],
    backMinutes: 15,
    owner: "Restore the sign-in provider's settings; sign in with the admin password.",
    drill: { name: null, why: "Breaking sign-in locks the owner out of the forge that would fix it." },
  },
  {
    key: "credential",
    name: "The model credential",
    breaks: "Agents cannot start work; everything else runs.",
    says: [],
    backMinutes: 5,
    owner: "Set a fresh credential in the settings.",
    drill: { name: "expire-token" },
  },
  {
    key: "runner",
    name: "The runner",
    breaks: "Checks and runs queue behind a lane that is not moving.",
    says: ["wait behind one lane; the oldest since", "is stuck: no heartbeat for"],
    backMinutes: 10,
    owner: "Cancel the stuck run; restart the runner if the lane stays empty.",
    drill: { name: "lose-runner" },
  },
];

const cell = (s: string): string => s.replace(/\|/g, "\\|");

/** One domain as its row in `docs/DOMAINS.md`. */
export function domainRow(d: Domain): string {
  const says = d.says.length === 0 ? "nothing yet" : d.says.map((s) => `"${s}"`).join("; ");
  const drill = d.drill.name === null ? `none: ${d.drill.why}` : d.drill.name;
  return `| ${[d.name, d.breaks, says, String(d.backMinutes), d.owner, drill].map(cell).join(" | ")} |`;
}
