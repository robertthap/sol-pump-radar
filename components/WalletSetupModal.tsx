"use client";
import { useState } from "react";

type Mode = "choose" | "generate" | "import" | "done";

export function WalletSetupModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("choose");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPubkey, setNewPubkey] = useState<string | null>(null);

  function reset() {
    setPass("");
    setPass2("");
    setSecret("");
    setError(null);
    setBusy(false);
  }

  function validatePassphrases(): string | null {
    if (pass.length < 6) return "Passphrase must be at least 6 characters.";
    if (pass !== pass2) return "Passphrases do not match.";
    return null;
  }

  async function generate() {
    setError(null);
    const v = validatePassphrases();
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/wallet/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: pass }),
      });
      const j = (await r.json()) as { publicKey?: string; error?: string };
      if (!r.ok || !j.publicKey) {
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      setNewPubkey(j.publicKey);
      setMode("done");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importExisting() {
    setError(null);
    const v = validatePassphrases();
    if (v) {
      setError(v);
      return;
    }
    if (!secret.trim()) {
      setError("Paste your secret key (base58 string or JSON array of 64 bytes).");
      return;
    }
    // Light client-side validation.
    const trimmed = secret.trim();
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed) as unknown;
        if (!Array.isArray(arr) || arr.length !== 64) {
          setError("JSON array must contain exactly 64 bytes.");
          return;
        }
      } catch {
        setError("Invalid JSON array.");
        return;
      }
    } else if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
      setError("Secret key must be base58 or a JSON byte array.");
      return;
    }

    setBusy(true);
    try {
      const r = await fetch("/api/wallet/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: pass, secretKey: secret }),
      });
      const j = (await r.json()) as { publicKey?: string; error?: string; detail?: string };
      if (!r.ok || !j.publicKey) {
        setError(j.detail ? `${j.error}: ${j.detail}` : (j.error ?? `HTTP ${r.status}`));
        return;
      }
      setNewPubkey(j.publicKey);
      setMode("done");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-panel">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Trading wallet</h2>
          <button type="button" onClick={onClose} className="btn btn-ghost text-xs">
            Close
          </button>
        </header>

        {mode === "choose" && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              This is a <strong>local-only</strong> trading wallet. Only fund it with SOL you are
              willing to lose. Its secret key is AES-256-GCM encrypted with your passphrase before
              it touches disk. The secret never leaves this machine.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  reset();
                  setMode("generate");
                }}
              >
                Generate new <span className="ml-1 rounded bg-ok/15 px-1.5 text-[10px] text-ok">recommended</span>
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  reset();
                  setMode("import");
                }}
              >
                Import existing
              </button>
            </div>
          </div>
        )}

        {mode === "generate" && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              We will generate a fresh Solana keypair and encrypt the secret with your passphrase.
              Pick a passphrase you can remember — there is no recovery.
            </p>
            <PassInputs
              pass={pass}
              pass2={pass2}
              setPass={setPass}
              setPass2={setPass2}
              disabled={busy}
            />
            {error && <p className="text-xs text-bad">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setMode("choose")}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={generate}
                disabled={busy}
              >
                {busy ? "Generating…" : "Generate wallet"}
              </button>
            </div>
          </div>
        )}

        {mode === "import" && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              Paste your secret key (64-byte). Accepts base58 (Phantom / Solflare export) or a JSON
              byte array (Solana CLI keypair file).
            </p>
            <PassInputs
              pass={pass}
              pass2={pass2}
              setPass={setPass}
              setPass2={setPass2}
              disabled={busy}
            />
            <label className="block text-xs text-muted">
              Secret key
              <textarea
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                rows={4}
                className="mt-1 w-full rounded border border-border bg-panel/60 px-2 py-1.5 font-mono text-xs"
                placeholder="3xQ… or [12,34,56,…]"
                disabled={busy}
              />
            </label>
            {error && <p className="text-xs text-bad">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setMode("choose")}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={importExisting}
                disabled={busy}
              >
                {busy ? "Importing…" : "Import wallet"}
              </button>
            </div>
          </div>
        )}

        {mode === "done" && newPubkey && (
          <div className="space-y-3">
            <p className="text-xs">
              Wallet ready. Fund this address with SOL on Solana mainnet to start trading.
            </p>
            <div className="flex items-center gap-2 rounded border border-border bg-panel/60 px-2 py-1.5">
              <code className="flex-1 font-mono text-[11px]">{newPubkey}</code>
              <button
                type="button"
                className="btn btn-ghost text-[11px]"
                onClick={() => navigator.clipboard.writeText(newPubkey)}
              >
                Copy
              </button>
            </div>
            <p className="text-[11px] text-muted">
              Your wallet is locked. Click <strong>Unlock</strong> in the header and enter your
              passphrase to start signing.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  onClose();
                  window.location.reload();
                }}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PassInputs(props: {
  pass: string;
  pass2: string;
  setPass: (s: string) => void;
  setPass2: (s: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="block text-xs text-muted">
        Passphrase
        <input
          type="password"
          value={props.pass}
          onChange={(e) => props.setPass(e.target.value)}
          className="mt-1 w-full rounded border border-border bg-panel/60 px-2 py-1.5 font-mono text-xs"
          autoComplete="new-password"
          disabled={props.disabled}
        />
      </label>
      <label className="block text-xs text-muted">
        Confirm
        <input
          type="password"
          value={props.pass2}
          onChange={(e) => props.setPass2(e.target.value)}
          className="mt-1 w-full rounded border border-border bg-panel/60 px-2 py-1.5 font-mono text-xs"
          autoComplete="new-password"
          disabled={props.disabled}
        />
      </label>
    </div>
  );
}
