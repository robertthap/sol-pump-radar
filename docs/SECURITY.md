# Security

## Localhost binding

The dev server binds to **127.0.0.1** only (`pnpm dev`, `next.config` / package scripts). Do not expose port 3000 to your LAN without adding authentication — the app has no multi-user auth layer.

API routes and workers assume a **single trusted operator** on the same machine.

This system is for personal use on a single machine. Treat it as such.

## Hard rules

- Never hardcode private keys.
- Never auto-unlock the wallet vault.
- Never log secrets, seeds, mnemonics, or private keys.
- Vault password is requested at runtime and held only in the isolated signer process memory.
- The signer enforces an allow-list of program IDs. Any other program ID in an instruction is rejected and triggers a HALT.
- All Docker ports are bound to `127.0.0.1` only. Do not expose them to a LAN or the public internet.
- The dashboard is bound to `127.0.0.1:3000` only.

## Logging

- A global `redact()` pass removes any base58 strings of length 32–88 from logs.
- Any field named `secret`, `key`, `seed`, `mnemonic`, `password`, or `vault*` is redacted.
- Errors are stripped of stack arguments before persisting.

## Files

- `.env` is gitignored.
- `data/` (vault, logs, exports) is gitignored.
- The vault file uses 0600 permissions (POSIX) or restricted ACL (Windows).

## Threat model

- Local-only attacker with file-system access is out of scope of v1 — protect your user account with normal OS hygiene.
- Remote attackers cannot reach any service (localhost binding).
- Malicious dependencies: pin versions; review `pnpm audit` before each release.
