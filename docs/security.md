# Security model

## Trust boundary

The Workstation Companion is the final authorization boundary. A phone command is authenticated user intent, not permission to bypass local policy.

## Production requirements

- QR pairing based on an out-of-band challenge and device public keys
- Device keys stored in Secure Enclave or Keychain
- Mutually authenticated sessions with forward secrecy
- End-to-end encrypted event and command envelopes
- Commands bound to device, workstation, project, Agent, task, action, expiry, and nonce
- Replay protection and idempotent command handling
- One-time approval by default; no silent widening to persistent access
- Explicit capability separation for view, message, approve, stop, snapshot, terminal, and desktop
- Local and mobile kill switches with auditable revocation
- APNs used only as a notification trigger, never as task-state truth

## Development restrictions

The initial relay has no production identity or cryptography. It binds to `127.0.0.1` by default and accepts only the configured development token. Starting it on another interface is an explicit developer action and still does not make it safe for untrusted networks.

Codex prompts are submitted only through supervised official CLI processes. For a new task, app-server registers the Desktop-visible thread and writes a static, non-actionable initialization item, then releases its writer before the CLI resumes the thread; app-server never submits the model turn. It reconnects afterward for session discovery and history. Unexpected app-server approval requests fail closed, unmatched approvals are declined, and unanswered approvals expire to `decline`. Persisted threads discovered from another Codex client are not represented as Companion-owned live tasks.

The Cursor fallback relay is local-only. Each Cursor IDE extension host publishes a discovery file inside the user's profile and a random 256-bit bearer token. macOS uses a mode-`0600` Unix socket and rejects discovery files owned by another user or writable by group/other. Windows uses a local named pipe and relies on the profile ACL plus bearer token. Both input helpers verify that Cursor is frontmost before emitting Unicode keyboard events and never use the clipboard. A keyboard submission is not reported as accepted until the read-only Cursor store exposes a new user bubble for the targeted composer. macOS Accessibility permission is the explicit local authorization boundary on that platform.

The Claude Code adapter reads only project transcript JSONL files and never opens Claude credential or settings files. Native executables receive remote messages as direct arguments without a shell. On Windows, an npm-installed `.cmd` shim requires the command shell, so the message is sent through stdin and is never interpolated into the command line. The Companion grants stop capability only to the exact child process it started and treats externally active sessions as read-only.

