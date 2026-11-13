# The first ask by ssh makes an app (#11975)

On a forge spawned for a person, the first `ssh <forge> tell <words>` from someone who has not told the crew yet makes a new app from the words and files the ask there (the same `firstAsk` the home page uses), instead of filing it on the forge's own source repository. It prints the new issue's address.

- **Only the first:** once the person has any issue of their own, `tell` goes to the forge's repository as before.
- **Not on an app's login:** `ssh <app>@<forge> tell` still goes to that app.
- **Not on other forges:** a forge that was not spawned (no `parent.json`) is unchanged.
- Code: `src/tui/ssh-tell.ts`; test: `test/ssh-tell-first-ask.test.ts`.
