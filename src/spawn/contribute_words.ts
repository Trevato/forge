/**
 * What an agent that only wants to contribute is told, in one place: the
 * `contribute` tool, `/llms.txt`, `/agents`, and `spawn` with `purpose: "contribute"` all say these words. A forge is for keeping; a
 * change to this one is made from a fork, a working copy in the agent's own
 * runtime, and a pull. Fixed words: nothing here echoes a request.
 */

/** The path that costs the host no forge (docs/features/send-a-change.md). */
export const CONTRIBUTE_PATH: readonly string[] = [
  "Fork the repository to your account (MCP `fork`, POST /api/v1/repos/{owner}/{name}/forks): a guest's fork is public, runs nothing and is bounded by the guest limits.",
  "Fetch the source at a commit with no git credential: curl -L https://<this forge>/{owner}/{name}/archive/<branch-or-commit>.tar.gz | tar xz (no network in your sandbox: read the MCP resource forge://source/{owner}/{name}@{ref}, ?path=src/dir for a part).",
  "Run the fast check in the copy: `bun scripts/gate.ts`, `bun x tsc --noEmit`, and the tests your change touches. To see it work, `bun src/main.ts` with FORGE_DATA in a temp directory, loopback only.",
  "Send the change without git: MCP `open_pull` with `patch` (a unified diff) or `files`, and `checks` (what you ran and how it ended). It lands as a branch on your fork with you as author, and a pull opens.",
  "A person approves the pull before any check runs; the forge then runs its own.",
];

export const CONTRIBUTE_ONE_LINE =
  "To change this forge you need no forge of your own: fork the repository, work in your own runtime on a copy of the source, send a patch with open_pull. That costs the host no forge.";

/** The three places a forge of your own can live, and who pays for each. */
export const WHERE_A_FORGE_LIVES: readonly { readonly where: string; readonly costs: string }[] = [
  { where: "hosted here", costs: "the host runs it in a cell and pays for its CPU, memory and disk: a forge to keep, within the host's capacity and your limits" },
  { where: "on your machine", costs: "you run `bun src/main.ts` (docs/ON-YOUR-MACHINE.md): your hardware, your electricity, nothing on the host" },
  { where: "on a cloud account", costs: "your operator's cloud account pays: the forge's Cloud page connects it; nothing on the host" },
];

/** Whether a spawn says, in so many words, that it is for contributing: `purpose: "contribute"` and nothing else. */
export function wantsToContribute(raw: Record<string, unknown>): boolean {
  const purpose = raw["purpose"];
  return typeof purpose === "string" && purpose.trim().toLowerCase() === "contribute";
}

/** What `spawn` answers then: the fork path, and that nothing was made. */
export const contributeAnswer = () => ({
  dryRun: true,
  created: false,
  says: `Nothing was made: ${CONTRIBUTE_ONE_LINE} A forge to keep is another matter (send purpose: "keep").`,
  contribute: CONTRIBUTE_PATH,
  where: WHERE_A_FORGE_LIVES,
});
