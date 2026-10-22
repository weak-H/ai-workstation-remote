# Contributing to AI Workstation Remote

Focused bug fixes, documentation improvements, tests, and compatibility fixes
are welcome. For substantial protocol, security, or architecture changes,
start with an issue that explains the problem and intended outcome.

## Development setup

Requirements:

- macOS or Windows
- Node.js 22 or newer
- npm

Install dependencies and start the development services:

```bash
npm install
npm run dev
```

The Web UI runs on `http://127.0.0.1:5173`; the relay and Workstation
Companion use `127.0.0.1:8787`.

## Before submitting a change

Run the checks relevant to your change. The normal baseline is:

```bash
npm test
npm run typecheck
npm run licenses
```

Use `npm run verify:codex`, `npm run verify:cursor`, or
`npm run verify:claude` when changing the corresponding adapter. These checks
inspect local client state, so report which ones you could run and any coverage
that was unavailable.

Keep changes focused. Update the English README or technical documentation
when behavior, configuration, security boundaries, or supported platforms
change. English is the canonical source for translated READMEs; translation
updates should preserve commands, paths, warnings, and links exactly.

## Pull requests

Every pull request needs a human owner who has reviewed the final diff and can
explain its behavior. AI-assisted contributions are welcome, but the human
owner remains responsible for the code, tests, documentation, and factual
claims.

In the pull request description, include:

- the concrete problem and observable outcome;
- the chosen approach and meaningful trade-offs;
- tests or checks run and their results;
- known gaps, platform limitations, or untested paths.

Do not include credentials, pairing URLs, private transcripts, proprietary
source, or other users' data in issues, logs, fixtures, or screenshots.

## License of contributions

Unless explicitly stated otherwise, contributions intentionally submitted for
inclusion in this project are provided under the repository's
[MIT License](LICENSE), without additional terms or conditions. By submitting
a contribution, you confirm that you have the right to do so.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues must follow [SECURITY.md](SECURITY.md).
