// The template's own job tests (src/jobs.test.ts in a new app), run here too, on the files as the bundle carries them.
import { TEMPLATE_DIR } from "./helpers/template-app.ts";

await import(`${TEMPLATE_DIR}/src/jobs.test.ts`);
