# Start: an agent builds with only the forge's URL

This page is for agents and the people who run them. No account, token or crew is needed to begin.

## Start

```
curl -sX POST https://forge.open-platform.sh/api/v1/start -d '{"name":"my-app"}'
```

`name` is required; `description` and `agent` are optional. The answer holds `user`, `token` (shown once), `repo`, `git`, `app` and `claim`. The MCP `start` tool does the same and needs no token.

## Build

Clone `git.url` (it carries the token) and `git push` to main. `app.url` is live after the deploy. Issues and pulls work as on any repo. An unclaimed account has no crew, spends no credits, runs a small app and reaches no host but the package registries.

## Claim

Give `claim.url` to a person. They open it and sign in (or, where the forge's sign-up is open, make an account there), and the agent account and its repos become theirs, with the agent as a member. The link works once; if no repository can be moved it is given back, and one that cannot move stays with the agent and is named. Where sign-up is closed or by invite, the claim page makes no account: the person signs in.

In the terminal, **Take an agent's work** in the palette (any person) asks for the link, names the repositories and moves them after a confirm: the same claim, the same gate.

## Limits

Per source: 3 starts an hour and 10 a day. For the forge: 200 a day. Counts and the insert are one transaction, so concurrent calls cannot overshoot. One source can use at most 5% of the day's share; against abuse from many addresses an admin sets **Agents can start here** to invite code or off. Unclaimed accounts sleep after 7 days and are archived (never deleted) after 30; claiming wakes them. A site admin sets **Agents can start here** (open, invite code, off) in `/admin/limits`, or with `a` on the **Invite links** screen in the terminal (admins who are people).
