# /forges side by side (#2933)

`/forges` opens with a table of every forge this one sent: name, address, size, memory, CPU and disk in use against the size, included apps, and the last heartbeat received. A child in its own cell reads from the cell's watch (disk from a bounded walk of its data directory, taken in the background (the page reads the last figure; the first view says "measuring"), kept 30 s); a hosted child shares this forge's process and reads "shared"; a cell not running reads "not running". The same fields (`size`, `use`, `lastHeartbeatAt`) are in the `forges` MCP tool.

Visible to this forge's admins; anyone else gets `not_found`.

The table is for comparing; the list below it stays for what needs doing (claim state, a fresh claim link, spend, next step). The terminal's "Forges you sent" card ends each line with the same size, use and heartbeat words. A cell that is not running reads "not running" under each use column; its limits are in the Size column. The disk reading is cached for 30 s per forge and forgotten after five minutes unasked.

## The pages' shape (#9647)

`/forges` is plain rows, no boxed cards: each forge's line starts with who it is for and the apps it was given, then its state (awake, size, spend, last activity, claim state). `/forges/new` asks the name, who it is for, what it is for, the apps and an optional fresh app up front; follow mode, crew, owner access, model key, API base URL, budget, template and size sit behind "More options", inside the same form so they submit as before. The disclosure opens by itself when the door refuses a value in one of them. No field or action was removed. The terminal's forge form is unchanged.
