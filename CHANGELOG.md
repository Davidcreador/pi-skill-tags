# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- Atomic Backspace and Delete handling for known skill tags, with single-step undo.

### Changed

- Preserve a `$` prefix on expanded skill names in the model-visible user message.

## [0.1.1] - 2026-07-14

### Added

- Screenshot showing inline skill tags in Pi's prompt editor.

## [0.1.0] - 2026-07-14

### Added

- `$` autocomplete for loaded project, global, and temporary skills.
- Theme-aware inline skill tags using `$[skill-name]` syntax.
- Submission-time expansion into Pi's native skill invocation format.
- Deduplication and aggregation of multiple skill tags.
- Standalone npm package metadata, documentation, tests, and release workflows.
