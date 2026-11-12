/** The keeper's answer to each flow alarm (`flow/alarms.ts`), in one sentence. */

export interface Did {
  readonly stuck: number;
  readonly reassigned: number;
  readonly lifted: number;
  readonly down: boolean;
}

export function sentence(key: string, did: Did): string {
  switch (key) {
    case "stuck":
      return `${did.stuck} stuck ${did.stuck === 1 ? "pull" : "pulls"} read; re-assigned ${did.reassigned} conflicted, lifted ${did.lifted} stale ${did.lifted === 1 ? "hold" : "holds"}.`;
    case "idle_crew":
      return "lull sampler watching; it writes a start event with the cause after two idle samples.";
    case "unreachable":
      return did.down ? "event written; the release keeper owns rollback." : "health sampled from two vantage points; no event until both fail twice.";
    default:
      return "reported only; the keeper acts on nothing here.";
  }
}
