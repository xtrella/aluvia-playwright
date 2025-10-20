# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [1.0.0] - 2025-10-20

### Added
- Initial release of **aluvia-playwright**.
- Transparent Playwright wrapper with automatic proxy rotation and retry logic.
- Support for all Playwright browser types: `chromium`, `firefox`, `webkit`.
- Auto-retry for `page.goto()` on configurable network errors.
- Proxy credentials fetched from Aluvia via API key.
- Event mirroring to keep page event listeners functional after proxy switch.
- TypeScript-first implementation with full type definitions.
- Environment variable configuration for retry/backoff/proxy logic.
- Example usage and documentation in `README.md`.

### Documentation

See `README.md` for:
- Installation instructions
- Example usage
- Environment variable setup
- API reference for wrapper methods

[1.0.0]: https://github.com/xtrella/aluvia-playwright/releases/tag/v1.0.0