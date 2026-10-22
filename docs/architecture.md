# Architecture

## Product boundary

The phone is a control plane. The macOS or Windows workstation remains the source of truth and the final execution authority. The relay can route data but cannot grant a capability that the workstation has not allowed.

The following diagram describes the production target, not the current development transport:

```text
Agent process
    -> Agent adapter
    -> Workstation Companion event ledger and policy engine
    -> encrypted direct or relay transport
    -> iPhone task store and user interface

iPhone signed command
    -> encrypted direct or relay transport
    -> Workstation Companion verification and final policy
    -> Agent adapter
    -> Agent process
```

## Components

### Agent adapter

An adapter owns interpretation of one Agent's native interface. Preferred sources are public structured APIs, SDK event streams, or a Companion-supervised CLI JSON stream. PTY text is a degraded source and must not be used to infer a high-risk approval.

### Workstation Companion

The production Companion normalizes events, assigns sequence numbers, persists the authoritative task ledger, reconnects transport, validates commands, applies local policy, and invokes adapters. It must continue to manage tasks while the phone or relay is offline.

### Control plane

The production control plane provides device discovery, connection negotiation, APNs triggers, encrypted message routing, bounded offline delivery, and relay fallback. It is not a task database and does not receive execution authority.

### Mobile client

The client renders the workbench, task details, approvals, and device status from structured events. It sends scoped user intent such as approve once, reject, correct, or stop. It never assumes that a sent command was executed until the workstation emits a confirming event.

## Development vertical slice

The current implementation uses Codex's structured app-server protocol for Desktop-visible thread registration, session discovery, and history, plus an in-memory WebSocket relay. It does not yet persist the normalized event ledger across Companion restarts. Creating a task registers a thread and injects a static, non-actionable initialization item so the rollout is resumable. The Companion then releases the app-server writer before the installed official `codex exec resume` client submits the first prompt with that thread id, and reconnects app-server for history sync; follow-up messages use the same CLI path. The app-server never submits a model turn. The Companion supervises only the CLI processes it starts, exposes stop control for those processes, and reconciles their temporary live timeline with the persisted app-server history. This path remains headless and never spoofs client metadata or drives the Desktop UI.

The Claude Code adapter treats `~/.claude/projects` JSONL transcripts as the read-only source of truth for discovery and history. When the local CLI is available, a mobile message starts a supervised non-interactive process with the original session id and working directory. Only that supervised process receives stop control; a session recently written by another Claude terminal remains read-only.

The ChatGPT desktop app's app-server uses private process pipes, so the Companion does not attach to that app-server or compete for its writer lock. Instead, it connects to Codex Desktop's same-user local IPC router, discovers the client that owns a thread, and forwards a `thread-follower-start-turn` request to that owner. Desktop remains the sole writer while mobile and Desktop continue the same thread and share persisted history. The Companion never forks a Desktop-owned session as an implicit fallback. If the IPC router or owner cannot be reached, the task fails closed to a read-only mirror.

## Adapter capability model

Every adapter must expose its actual capabilities. Required capabilities are task lifecycle, progress text, final result, sending a message, and stopping. Approvals, structured tool calls, pause/resume, diff, tests, and screenshots are optional capability-gated features.

