# What the forge is for
The forge is a social place for building. Everyone who joins gets a whole forge of their own: their apps, and a crew that builds them. People share what they make, take what others made and mold it, and the best of it rises through a visible tree of forks, while anyone can stay as private and as different as they like. Opening it should feel like opening X: you get it at once. Steering it should take one thought: type it, go.

## Order of work
0. **Trust, always first.** Agents are contained. Agent pulls are reviewed. The gate runs every test. Admin is a separate account from the everyday one, explained kindly and directly; using AI with admin stays possible but deliberate. Private by default, and always plain about who can see what.
1. **One front door: the feed.** Home is an X-style timeline that IS the git primitives: a post is a tell or an issue; a reply is a comment; a repost or quote is a share or a fork; a like is a signal written to the decision ledger; a crew member's posts are its runs, pulls and looks. The crew reads and writes through the same feed. There is no dev/studio split: one interface, with every developer depth (files, diffs, runs, terminal) one step deeper from any post.
2. **The explorer.** Apps, forges and people ranked by real metrics (use, forks, ships, likes, freshness), and trivially filterable to exactly what you want. Every app says "make it yours": one action forks it into your forge.
3. **The fork tree is the organization.** My forge is the public upstream; an organization's forge forks it; each person's forge forks their organization's. Every fork chooses how it follows its upstream. The tree is visible and a pleasure to browse; good changes bubble up as offers and flow down as updates.
4. **A forge in a link.** I (or my agent, through the MCP) create a forge for a person, a client or an organization: chosen apps (some forked from mine, some still autonomous so they see it cooking), a starter budget, an admin account, one link. First login shows their crew working right now in the feed, and three next steps: make your everyday account, open your apps, tell the crew something. They add their people; each new person gets their own forge that follows the organization's. A client list tracks who was sent what and what happened.
5. **Open to every agent.** Any agent or harness can find and use a forge: the MCP with OAuth (Claude app, Grok in a car); a role-aware, token-efficient manifest on every page saying what you can do here as who you are; standards metadata; and on a public app or repo, an outside person or agent can file a report or offer a pull without being taught how.
6. **Never lost.** A forge toolbar in every app and preview: where you are (app, environment, which pull this previews), who is working on it, comment on this page or its issue or pull, tell the crew from here, make it yours. Later: in a preview, a tint on what changed and its diff on selection.
7. **Steering is one thought.** Tell from anywhere: the feed composer, the toolbar, a phone share sheet, the MCP.

## How we build
- A deterministic tool with deliberate noise: actions are explicit, previewed and receipted; AI judgment only where we say so.
- The same action has the same shape for a person and an agent: a page and an MCP tool, in the same words.
- Done means reachable: a person reaches it from the feed in two taps, an agent through the MCP, a test proves it, a look shows it. A function nobody can call is not done.
- Far ideas go on the map behind what they depend on, and we trim honestly.

## The tests
- **Link test:** someone opens a link to their new forge and, within a minute and without a word from me, sees a crew working and knows what to do next.
- **Muse test:** an outside agent looking at a public forge app finds out how to report a problem or offer a change, and does it.
- **Friend test:** someone I send an app to makes it theirs in one action.
- **Tesla test:** any MCP client connects with OAuth and steers.
- **Lost test:** from any app or preview you know where you are and can get home, comment, or tell the crew.
- **Admin test:** a new owner is guided to a separate everyday account, told why in two sentences, and can still choose otherwise on purpose.
