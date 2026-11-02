# Security contact

`/.well-known/security.txt`'s `Contact:` is the forge's own repository's sealed report form (`/<FORGE_REPO>/issues/new?sealed=1`) when `FORGE_REPO` names a public repository here; a sealed report needs an account, so a signed-out visitor is offered only Sign in, and comes back to the sealed form after it (the no-account report is not sealed and is not offered there).
Otherwise the contact is the first account's page; `FORGE_SECURITY_CONTACT` overrides both (`src/web/standards.ts`, `src/core/forge_repo.ts`).
