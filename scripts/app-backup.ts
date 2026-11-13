/**
 * An app's encrypted backup and its restore proof, run by the owner:
 *   APP_BACKUP_PASSPHRASE=… bun scripts/app-backup.ts seal <data-dir> <out-file>
 *   APP_BACKUP_PASSPHRASE=… bun scripts/app-backup.ts prove <backup-file> <empty-scratch-dir>
 * The work is src/apps/backup_cli.ts. See docs/features/app-backup.md.
 */
import "../src/apps/backup_cli.ts";
