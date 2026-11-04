# Writing documentation

This guide sets the rules for documentation in this repository. It applies to
people and agents.

## Style

- Write standard technical English: short declarative sentences, present tense, active voice.
- Use defined terms and concrete nouns. Say what a thing does before why.
- Make each heading say what its section covers.
- Do not use slang, hype, metaphors, inside jokes or the word "magic".
- Do not tell incident stories. State the rule the incident produced.
- Do not put issue numbers in prose meant for newcomers.
- Do not use em dashes in new text. `test/dependencies-named.test.ts` requires one in the Dependencies list.

## Accuracy

- Say only what is true of today's code. Check each claim against the code or a test.
- Cut or fix a claim you cannot confirm.
- Do not overclaim security, scale or autonomy.
- Say what is not done where a reader would otherwise assume it is.
- Remove nothing of technical substance from a reference document. Move it instead.

## Opening screen

Each document opens with what it covers, who it is for and the key idea, in under 120 words.

## Terms

- **Forge:** your software and the crew that builds it, in one place. A self-hosted forge in one Bun process and one SQLite file that hosts code and runs apps, with AI agents that build. Forges connect to one another.
- **App:** a repository that the forge runs.
- **Crew:** the AI agents that work on a forge.
- **Origin:** a connected account on another forge.

## Before and after

A claim that cannot be checked, from the repository description:

> Before: A software forge you can read in an afternoon and mold by hand.
>
> After: Your software and the crew that builds it, in one place.

A figure of speech, from `docs/ORIGINS.md`:

> Before: All forges share the same units, so the adapters are small and boring, which is the point.
>
> After: Adapters are small because forges share the same units: issues, pulls, comments and labels.

An issue number and a slogan, from `docs/STUDIO.md`:

> Before: One forge, for every viewer (#603).
>
> After: The forge shows one interface to every viewer.
