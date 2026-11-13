/**
 * Where the engine runs. `inline` (the default) is the forge as it always was:
 * one thread serves and works. `worker` (`FORGE_ENGINE=worker`) puts the
 * engine's duties (`duties.ts`) on a Worker of this process with its own
 * database handle, so what they cost never holds a page.
 *
 * A hosted child (a cell of another forge: 1 CPU, one thread to share), a
 * read-only standby and a test boot stay `inline` whatever the variable says;
 * a test that wants the split asks for it itself (`optIn`).
 */

export type EngineMode = "inline" | "worker";

export function engineMode(
  env: Record<string, string | undefined>,
  where: { hosted: boolean; readOnly: boolean; optIn?: boolean },
): EngineMode {
  if (env["FORGE_ENGINE"] !== "worker") return "inline";
  if (where.hosted || where.readOnly) return "inline";
  if (env["NODE_ENV"] === "test" && where.optIn !== true) return "inline";
  return "worker";
}
