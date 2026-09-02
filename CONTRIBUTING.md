# Contributing

I am open to, and grateful for, any contributions made by the community.
Because the life is too short to write a lot of documentation, I've copied some rules
from axios' [CONTRIBUTING](https://raw.githubusercontent.com/axios/axios/master/CONTRIBUTING.md) docs.

### Commit Messages

Commit messages should be verb based, using the following pattern:

- `Fixing ...`
- `Adding ...`
- `Updating ...`
- `Removing ...`

### Documentation

Please update the docs accordingly so that there are no discrepencies between the package and the documentation.

### Developing

Please use npm and install the locked dependency graph with `npm ci`.
Run `npm run check` before opening a pull request; it type-checks, runs the deterministic test suite with coverage,
and verifies the distributable build.
Please, do not include any `OS/IDE specific files` in your pull request.

### Build

Use `npm run build` to build the package. The generated `dist/` directory is intentionally not tracked.
