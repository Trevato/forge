# Live updates

- `.live-news` — the fixed, bottom-centred, click-through wrapper of the live-update pill. The pill is a §5 badge (attn tone) inside it; the wrapper keeps it out of flow so showing it moves nothing, and the rule gives that badge a 36px target. A bare `.badge` cannot carry this: it is a small inline element that would insert itself into the content where the mount sits.
