# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-10-21

### Changed

- Switched to dual ESM and CommonJS build output for full compatibility with modern and legacy Node.js consumers.
- Updated TypeScript configuration to use `moduleResolution: nodenext` and `module: NodeNext` for proper module resolution.
- Improved package.json with conditional exports and `module` field.
- Added separate tsconfig files for CJS and ESM builds.

### Fixed

- Resolved build errors related to module resolution and missing types.
- Ensured type declarations are generated and compatible with both module systems.

### Internal

- Refactored build scripts and project structure for maintainability and future extensibility.

[1.1.0]: https://github.com/xtrella/aluvia-playwright/releases/tag/v1.1.0

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
