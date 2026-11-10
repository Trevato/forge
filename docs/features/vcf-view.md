# Contacts files (.vcf) as a list of people

Open a `.vcf` or `.vcard` file in a repository and read it as a list of its contacts, in file order, from a card's name and organisation to its email, phone, web and note.

- **Web:** the blob page draws one row per person, with the labelled facts folded under the name so it fits a phone (`src/web/render/vcf.ts`). Values are escaped and urls are text, never links. Files over 5 MB, or with no complete card, show as source; past 500 contacts a "Showing first N" line says how many were left out. `?view=source`, Raw and Download work as for any file.
- **Terminal:** the workspace opens the same file as a table of name, organisation, email and phone, sharing the parser; `s` flips to the source. The status line reads `N contacts`.

Not done: vCard 2.1 quoted-printable and photos.
