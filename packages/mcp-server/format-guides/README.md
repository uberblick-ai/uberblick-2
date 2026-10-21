# Format guide stand-ins

`get_help` serves the authoring guide that each drawn format's npm package
ships, at the version this workspace resolves. `scripts/sync-format-guides.mjs`
copies it into `src/generated/format-guides.ts`.

Until a package ships its guide, the script reads `<topic>-<version>.md` here
instead and records `standIn: true`. Delete a stand-in once its package ships
the guide; the sync test then fails if the stand-in is still used.
