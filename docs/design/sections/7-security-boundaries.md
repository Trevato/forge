## 7. Two rules that are security boundaries

**Label colors.** Inline `style=""` is blocked by the CSP — nonces apply to
elements, not attributes. A page therefore collects the label colors it will
render and emits one nonce'd rule per color:

```css
.lc-d73a4a {
  --label: #d73a4a;
}
```

and the static sheet derives the chip from it with `color-mix`, so one stored
hex reads correctly in all six themes. `labelCss()` re-validates
`/^[0-9a-f]{6}$/` immediately before embedding. That check is the boundary —
treat it like `assertBatchSafe`, not like a nicety.

**The confirm page.** Every destructive button is a link to `/-/confirm?to=…`.
That page derives its own title, detail and typed-phrase requirement from a
table of known destructive routes, and 404s on anything else. The wording never
comes from the link, so a mailed URL cannot put "Continue" on a button that
deletes a repository.
