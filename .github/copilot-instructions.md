# Copilot Coding Agent Instructions

This repository uses the Copilot Coding Agent for automated code changes and pull requests.
Please follow these best practices when contributing to **MMM-Sonos**.

---

## 1. Task Planning

- Break down large tasks into smaller, actionable steps.
- Use structured todo lists (markdown checklists) to track progress.
- Use **report_progress** to commit and push after each meaningful unit of work.
- Mark items as in-progress and completed as work progresses.

---

## 2. Code Changes

- Make **surgical, minimal changes** that fully address the requirement — do not modify unrelated code.
- Use clear, concise commit messages referencing related issues or PRs (e.g. `feat: cache album art locally (#42)`).
- Prefer atomic commits for each logical change.
- Follow the existing code style (2-space indentation, `'use strict'`, single quotes, no semicolons at statement ends in config objects).
- All JavaScript files must pass ESLint before merging: `npm run lint`.

---

## 3. Changelog

- **Always update `CHANGELOG.md`** whenever code changes are made to the repository.
- Follow the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.
- Add entries under `## [Unreleased]` using the appropriate section:
  - `### Added` – new features
  - `### Changed` – changes in existing functionality
  - `### Fixed` – bug fixes
  - `### Security` – security-related changes
  - `### Removed` – removed features

---

## 4. Tests

- Run existing tests after every change: `npm test`.
- Add new unit tests for any new functions or significant logic changes.
- Tests live in the `test/` directory and use Node.js built-in test runner (`node:test`).
- Test file naming convention: `test/<subject>.test.js`.
- Tests must pass before merging (`npm test` must exit with code 0).

---

## 5. Pull Requests

- Open pull requests for all changes, even minor ones.
- Add descriptive titles and summaries.
- Link to relevant issues.
- Request reviews from appropriate collaborators when needed.

---

## 6. Documentation

- Update `README.md` for any user-facing changes (new config options, features, etc.).
- Add code comments for complex logic or non-obvious decisions.
- Keep the docs directory (`docs/`) updated with screenshots when the UI changes.

---

## 7. Error Handling & Security

- Run `npm run audit` to check for security vulnerabilities before merging.
- Run `npm run lint` and `npm test` after each change.
- Never commit secrets, credentials, or environment-specific configuration.
- Add `cache/` and other generated directories to `.gitignore`.

---

## 8. Repository Structure

| File / Directory              | Purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `MMM-Sonos.js`                | Front-end module (runs in browser via MagicMirror²) |
| `node_helper.js`              | Back-end helper (runs in Node.js)                    |
| `css/MMM-Sonos.css`           | Module styles                                        |
| `translations/`               | i18n translation files                               |
| `assets/`                     | Static assets (SVG icons, screenshots)               |
| `docs/`                       | Screenshots and documentation images                 |
| `test/`                       | Unit tests (Node.js built-in test runner)            |
| `cache/album-art/`            | Local album art cache (gitignored, auto-created)     |
| `CHANGELOG.md`                | Change history (always update on changes)            |
| `.github/copilot-instructions.md` | This file                                        |

---

For more information, see [Best practices for Copilot coding agent in your repository](https://gh.io/copilot-coding-agent-tips).

