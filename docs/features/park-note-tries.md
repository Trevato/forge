# A park note tells what each failed try changed

When the crew parks a pull because its check stayed red, the "Parked by the crew" comment on the issue the pull closes adds one line per failed try, oldest first:

```
try 1: src/a.ts, src/b.ts
try 2: src/b.ts (+3 more)
```

- Each line is the head the check went red on and the files it changed since the try before it (the first, since the base): at most 5 tries, at most 10 files each.
- Only tries after the last human word on the pull count, the same ones that counted toward the park.
- A pull with fewer than two failed tries adds nothing.
- Code: `triesChanged` in `src/crew/tries.ts`, told by `parkPullTold` in `src/crew/park_pull.ts`.
- Try it: let an autonomous repo's agent pull go red twice and read the issue's comments.
