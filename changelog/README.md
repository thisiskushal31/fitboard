# Release changelogs

Each GitHub Release body comes from a short Markdown file here—not from an auto-generated commit or PR list.

## Convention

- One file per version: `X.Y.Z.md` (no leading `v`).
- An LTS tag (`X.Y.Z-lts`) reuses the same file as `X.Y.Z`.
- Write the notes **before** you push the tag. The release workflow fails if the file is missing.

## What to write

Keep it concise: what this version adds, changes, or fixes. A few bullets are enough. Do not add a “Full Changelog” compare link yourself — CI strips any such line from the file and adds exactly one when it publishes (and replaces the release body on a re-tag, so links do not stack).

## Example

```markdown
### Added

- Company filter on Find jobs from the job-boards catalog.

### Fixed

- Posting detail pane scroll on long descriptions.
```
