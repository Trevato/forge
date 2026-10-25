/**
 * forge for OpenCode: registers the forge's MCP server and a `forge`
 * command (tell, status, decide, plan). Set FORGE_URL and FORGE_TOKEN.
 * No logic lives here: the tools are the forge's own (`docs/MCP.md`).
 */
import type { Plugin } from "@opencode-ai/plugin";

const COMMAND = `Use the forge MCP tools for: $ARGUMENTS
- tell <app> <words>: call \`tell\` with repo and text; pass context { page, run, commit, said }.
- status: call \`now\` and \`asks\`; say in three sentences what runs and what waits on the person.
- decide approve|redirect|decline: call \`asks\`; approve -> \`asks_act\` ship, decline -> \`asks_act\` close, redirect -> \`say\`. Plan first, apply (dryRun false) only after the person says yes.
- plan [approve|redirect <words>|later]: call \`asks\`; show the first wave-proposal row (the planner's next wave) in a few lines. approve|redirect|later -> \`asks_proposal\` with that row's id and verb (redirect carries the words as \`words\`). Say what it will do and apply only after the person says yes.
Never merge: a person lands changes.`;

export const Forge: Plugin = async () => ({
  config: async (config: Record<string, any>) => {
    const url = process.env["FORGE_URL"];
    const token = process.env["FORGE_TOKEN"];
    if (!url || !token) return;
    config["mcp"] = {
      ...config["mcp"],
      forge: {
        type: "remote",
        url: `${url.replace(/\/$/, "")}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    };
    config["command"] = {
      ...config["command"],
      forge: { description: "Tell, status, decide or plan on your forge", template: COMMAND },
    };
  },
});

export default Forge;
