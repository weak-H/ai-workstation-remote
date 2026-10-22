# Security Policy

## Supported versions

This project is an active prototype and has not published a production-ready
security release. Security fixes are applied to the latest revision. Reproduce
an issue against the latest revision when it is safe to do so.

## Reporting a vulnerability

Do not disclose vulnerabilities, proof-of-concept exploits, credentials,
pairing URLs, session transcripts, private source code, or local client data in
a public issue.

Use **Report a vulnerability** in the repository's **Security** tab to open a
private report. If private vulnerability reporting is unavailable, contact the
maintainers through a private channel listed by the repository owner before
sharing sensitive details.

Include the affected revision and platform, impact, minimum reproduction steps,
and any suggested mitigation. Remove tokens, account identifiers, proprietary
content, and unrelated local paths from logs and screenshots.

## Current security status

The relay binds to loopback, but remote access currently uses a temporary
Cloudflare Quick Tunnel plus a random bearer token in the URL. It does not yet
provide device public keys, signed commands, end-to-end encrypted application
envelopes, or a persistent replay ledger. Treat the remote mode as development
and testing infrastructure, not production authentication.

Anyone who obtains the complete tunnel URL may attempt to access the relay.
Do not use the prototype with sensitive repositories or across untrusted
networks. Stop the launcher to invalidate the temporary tunnel URL.

For the detailed trust boundary, adapter behavior, and planned production
controls, read [`docs/security.md`](docs/security.md).
