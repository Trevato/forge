/**
 * forge for OpenCode: registers the forge's MCP server and a `forge`
 * command (new, tell, status, decide, archive, undo, plan, preview, pulls, runs, log, asked, waves, held, forks). Set FORGE_URL, and FORGE_TOKEN too
 * to skip the OAuth sign-in.
 * No logic lives here: the tools are the forge's own (`docs/MCP.md`).
 */
// The shape OpenCode loads; typed here so the forge need not install its SDK.
type Plugin = () => Promise<{ config: (config: Record<string, any>) => Promise<void> }>;

const COMMAND = `Use the forge MCP tools for: $ARGUMENTS
- new <name> <words>: say the name and description back and ask the person to confirm. Only after the person says yes, call \`new_app\` with name and description (the words); relay in two lines the app's page (its url) and the next step (the first issue and who picked it up). If \`new_app\` refuses (name_taken, unverified, app_limit, repository_limit, storage_limit, no_such_agent), say its own message in one line; for name_taken, offer another name. Never retry without asking.
- tell <app> <words>: call \`tell\` with repo and text; pass context { page, run, commit, said }.
- status: call \`now\` and \`asks\`; say in three sentences what runs and what waits on the person.
- decide approve|redirect|decline: call \`asks\`; approve -> \`asks_act\` ship, decline -> \`asks_act\` close, redirect -> \`say\`. Plan first, apply (dryRun false) only after the person says yes.
- archive <app>: call \`archive\` with \`repo\` = the app (owner/name), planned first (\`dryRun\` defaults to true; \`archived\` true): show what would change and ask the person to confirm. Only after they say yes, call it again with \`dryRun: false\`. The receipt says it is put away, not deleted, and how to wake it: \`archive\` with \`archived: false\`, by saying archive <app> again.
- decide all <dismiss|ship|close> [kind]: call \`asks\`; take every row (only those whose kind is \`kind\`, when given) and plan \`asks_act\` with \`action\` = the word and \`items\` = their ids. Say how many and which, one line each. Only after the person says yes, call \`asks_act\` again with the same \`items\` and \`dryRun: false\`, then print the \`operation\` id with undo <operation>. \`asks_act\` takes at most 100 \`items\`: with more rows, plan and apply only the first 100, say how many remain, and offer to run it again for the rest.
- undo <operation>: call \`asks_act\` with \`action: "undo"\` and \`operation\` = the id, planned first (\`dryRun\` defaults to true, and then only answers \`wouldUndo\`); after the person says yes, call again with \`dryRun: false\`; say what it reversed from the receipt. Never say it is undone before that second call.
- plan [approve|redirect <words>|later]: call \`asks\`; show the first wave-proposal row (the planner's next wave) in a few lines. approve|redirect|later -> \`asks_proposal\` with that row's id and verb (redirect carries the words as \`words\`). Say what it will do and apply only after the person says yes.
- preview <url>: call \`preview\` with url; say in two lines the app, environment, pull, check and who is working.
- pulls <app>: call \`pulls\` with repo; list the open pulls, one line each with its check.
- runs <app>: call \`runs\` with repo; say, one line each, the running runs and the last three finished: kind, issue or pull number, state, how long (startedAt to endedAt, or to now).
- log <app> <run>: call \`run_log\` with repo, run (the run id) and \`tail\` 40; relay the lines verbatim.
- asked [app]: call \`asked\` with \`show\` \`all\`, and repo when an app is given; say, one line each, flagged ones first, what was asked (title and number), its state (waiting, building, shipped or closed), the pull that closes it and the \`outcomeText\` sentence, so a parked or failed ask says why.
- waves <app>: call \`waves\` with repo; relay the newest three waves, one line each: version, date, headline. Read-only: it lands nothing.
- held: call \`held\` with app = the app the conversation names; when none is named, ask which app before calling, since \`held\` needs one (never \`apply\`); say in two sentences how many themes the Later gate holds and which are done (the issues in \`approve\`). Read-only: never close or land anything.
- forks <app>: call \`forks\` with repo and kind "chain"; say in two lines what it follows upstream (parent, grandparent, or none) and who follows it downstream (children, or none), noting a severed link. Read-only.
Never merge: a person lands changes.`;

export const Forge: Plugin = async () => ({
  config: async (config: Record<string, any>) => {
    const url = process.env["FORGE_URL"];
    const token = process.env["FORGE_TOKEN"];
    if (!url) return;
    config["mcp"] = {
      ...config["mcp"],
      forge: {
        type: "remote",
        url: `${url.replace(/\/$/, "")}/mcp`,
        // No token: no header, and `oauth: {}` lets OpenCode sign in through the forge's OAuth.
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : { oauth: {} }),
      },
    };
    config["command"] = {
      ...config["command"],
      forge: { description: "New, tell, status, decide, archive, undo, plan, preview, pulls, runs, log, asked, waves, held or forks on your forge", template: COMMAND },
    };
  },
});

export default Forge;
