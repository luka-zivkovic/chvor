import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSessionStore } from "../../../stores/session-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export function SecurityContent() {
  const { authEnabled, authMethod, checkStatus, apiKeys, fetchApiKeys } = useSessionStore();
  const [loading, setLoading] = useState(true);

  // Auth setup state
  const [showSetup, setShowSetup] = useState(false);
  const [setupMethod, setSetupMethod] = useState<"password" | "pin">("password");
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupPin, setSetupPin] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [setupError, setSetupError] = useState("");

  // API key state
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [disableConfirm, setDisableConfirm] = useState(false);
  const [disableCredential, setDisableCredential] = useState("");
  const [disableError, setDisableError] = useState("");

  useEffect(() => {
    setLoading(false);
    if (authEnabled) fetchApiKeys();
  }, [authEnabled, fetchApiKeys]);

  const handleSetup = async () => {
    setSetupError("");
    try {
      const body = setupMethod === "password"
        ? { method: "password" as const, username: setupUsername, password: setupPassword }
        : { method: "pin" as const, pin: setupPin };
      const result = await api.auth.setup(body);
      setRecoveryKey(result.recoveryKey);
      setShowSetup(false);
      await checkStatus();
      fetchApiKeys();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Setup failed");
    }
  };

  const handleDisable = async () => {
    setDisableError("");
    try {
      const body = authMethod === "password"
        ? { password: disableCredential, username: setupUsername || undefined }
        : { pin: disableCredential };
      await api.auth.disable(body);
      setDisableConfirm(false);
      setDisableCredential("");
      await checkStatus();
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : "Invalid credentials");
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;
    try {
      const result = await api.auth.createApiKey({ name: newKeyName.trim() });
      setCreatedKey(result.key);
      setNewKeyName("");
      fetchApiKeys();
    } catch {
      // ignore
    }
  };

  const handleRevokeKey = async (id: string) => {
    await api.auth.revokeApiKey(id);
    fetchApiKeys();
  };

  if (loading) return <p className="text-xs text-muted-foreground">Loading...</p>;

  return (
    <div className="flex flex-col gap-5">
      {/* Authentication */}
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Authentication
      </h3>

      {recoveryKey && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
          <p className="text-[10px] uppercase tracking-widest text-yellow-500 mb-2">
            Save Your Recovery Key
          </p>
          <p className="font-mono text-sm text-foreground select-all break-all mb-2">
            {recoveryKey}
          </p>
          <p className="text-[10px] text-muted-foreground">
            This key is shown only once. Save it somewhere safe — you'll need it if you forget your password.
          </p>
          <Button size="sm" className="mt-2" onClick={() => {
            navigator.clipboard.writeText(recoveryKey);
            toast.success("Copied to clipboard");
          }}>
            Copy
          </Button>
          <Button size="sm" variant="ghost" className="mt-2 ml-2" onClick={() => setRecoveryKey("")}>
            Dismiss
          </Button>
        </div>
      )}

      {!authEnabled && !showSetup && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Authentication is <span className="text-foreground font-medium">disabled</span>.
            Your instance is accessible without login.
          </p>
          <Button size="sm" onClick={() => setShowSetup(true)}>
            Enable Authentication
          </Button>
        </div>
      )}

      {showSetup && (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <div className="flex flex-col gap-2">
            <label className="text-xs text-muted-foreground">Method</label>
            <select
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              value={setupMethod}
              onChange={(e) => setSetupMethod(e.target.value as "password" | "pin")}
            >
              <option value="password">Username & Password</option>
              <option value="pin">PIN / Passphrase</option>
            </select>
          </div>
          {setupMethod === "password" && (
            <>
              <div>
                <label className="text-xs text-muted-foreground">Username</label>
                <Input value={setupUsername} onChange={(e) => setSetupUsername(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Password (min 6 chars)</label>
                <Input type="password" value={setupPassword} onChange={(e) => setSetupPassword(e.target.value)} className="mt-1" />
              </div>
            </>
          )}
          {setupMethod === "pin" && (
            <div>
              <label className="text-xs text-muted-foreground">PIN / Passphrase (min 6 chars)</label>
              <Input type="password" value={setupPin} onChange={(e) => setSetupPin(e.target.value)} className="mt-1" />
            </div>
          )}
          {setupError && <p className="text-xs text-destructive">{setupError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSetup} disabled={
              setupMethod === "password"
                ? !setupUsername || setupPassword.length < 6
                : setupPin.length < 6
            }>Enable</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSetup(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {authEnabled && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Authentication is <span className="text-green-400 font-medium">enabled</span>.
          </p>
          {!disableConfirm ? (
            <Button size="sm" variant="destructive" onClick={() => setDisableConfirm(true)}>
              Disable Authentication
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-destructive">Enter your {authMethod === "password" ? "password" : "PIN"} to confirm:</p>
              <input
                type="password"
                className="w-full bg-background border border-border rounded px-2 py-1 text-xs"
                placeholder={authMethod === "password" ? "Password" : "PIN"}
                value={disableCredential}
                onChange={(e) => setDisableCredential(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleDisable()}
                autoFocus
              />
              {disableError && <p className="text-[10px] text-destructive">{disableError}</p>}
              <div className="flex items-center gap-2">
                <Button size="sm" variant="destructive" onClick={handleDisable} disabled={!disableCredential}>Yes, disable</Button>
                <Button size="sm" variant="ghost" onClick={() => { setDisableConfirm(false); setDisableCredential(""); setDisableError(""); }}>Cancel</Button>
              </div>
            </div>
          )}

          {/* API Keys */}
          <div className="mt-2 border-t border-border pt-4">
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              API Keys
            </h3>
            <p className="text-[10px] text-muted-foreground/60 mb-3">
              Generate keys for programmatic access (CLI, scripts, integrations).
            </p>

            {createdKey && (
              <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 mb-3">
                <p className="text-[10px] uppercase tracking-widest text-green-500 mb-1">
                  New API Key (shown once)
                </p>
                <p className="font-mono text-xs text-foreground select-all break-all">
                  {createdKey}
                </p>
                <Button size="sm" className="mt-2" onClick={() => {
                  navigator.clipboard.writeText(createdKey);
                  toast.success("Copied to clipboard");
                }}>
                  Copy
                </Button>
                <Button size="sm" variant="ghost" className="mt-2 ml-2" onClick={() => setCreatedKey("")}>
                  Dismiss
                </Button>
              </div>
            )}

            <div className="flex gap-1.5 mb-3">
              <Input
                placeholder="Key name (e.g. my-script)"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="text-xs"
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateKey(); }}
              />
              <Button size="sm" onClick={handleCreateKey}>Generate</Button>
            </div>

            {apiKeys.filter(k => !k.revokedAt).map((key) => (
              <div key={key.id} className="flex items-center justify-between rounded-md border border-border/50 p-2 mb-1.5">
                <div>
                  <p className="text-xs text-foreground">{key.name}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    chvor_{key.prefix}...
                    {key.lastUsedAt && ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleRevokeKey(key.id)}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shell command approval moved to Permissions panel */}
    </div>
  );
}
