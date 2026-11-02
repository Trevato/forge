/**
 * The one shape of `changed` on `repo.settings_updated`: each setting a change
 * moved, from what to what. Every writer of that event builds it here, so one
 * read of the kind answers "from what to what" for every row.
 */

export type SettingsChanged = Record<string, { from: unknown; to: unknown }>;

/** `{ [setting]: { from, to } }`, or `{}` when nothing moved. */
export function settingMoved(setting: string, from: unknown, to: unknown): SettingsChanged {
  return from === to ? {} : { [setting]: { from, to } };
}
