# What holds a ready issue

`GET /api/v1/repos/:owner/:name/map` and the MCP `map` tool give each `ready` entry `held`: `null`, or `{ by, detail }` with `by` one of the names in `src/crew/held.ts` (`open_pull`, `hot_file`, `run_cap`, …). For `hot_file`, `detail` names the file and its count of open pulls. `startable` lists the ready numbers nothing holds.

Holds are worked out for the viewer: a pull they may not see (a sealed one) neither counts toward a hot file nor holds an issue as `open_pull`. So a guest's `startable` can list an issue the crew will not start; read it as what the viewer can see is free, not as the crew's queue. The direction issue is never in `startable` but shows `held: null`. Hot-file counts come from memory, so a cached map can lag them by up to a minute.
