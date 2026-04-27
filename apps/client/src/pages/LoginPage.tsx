import { useState } from "react";
import { useSessionStore } from "../stores/session-store";
import { api } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginPage() {
  const { authMethod, login, loading, error } = useSessionStore();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [recoverySuccess, setRecoverySuccess] = useState("");
  const [newRecoveryKey, setNewRecoveryKey] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authMethod === "password") {
      const ok = await login({ username, password });
      if (ok) { setPassword(""); setUsername(""); }
    } else {
      const ok = await login({ pin });
      if (ok) setPin("");
    }
  };

  const handleRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError("");
    setRecoverySuccess("");
    try {
      const credential = authMethod === "password" ? newPassword : newPin;
      const result = await api.auth.recover({
        recoveryKey,
        method: authMethod!,
        username: authMethod === "password" ? newUsername : undefined,
        password: authMethod === "password" ? credential : undefined,
        pin: authMethod === "pin" ? credential : undefined,
      });
      setNewRecoveryKey(result.recoveryKey);
      setRecoverySuccess("Password reset successful. Save your new recovery key!");
      setNewPassword(""); setNewPin(""); setRecoveryKey("");
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : "Recovery failed");
    }
  };

  if (showRecovery) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-6 rounded-xl border border-border/50 bg-card/80 p-8 backdrop-blur-xl">
          <div className="text-center">
            <h1 className="text-lg font-semibold text-foreground">Reset Credentials</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Enter your recovery key to reset your {authMethod === "password" ? "password" : "PIN"}
            </p>
          </div>

          {newRecoveryKey ? (
            <div className="space-y-4">
              <p className="text-xs text-green-400">{recoverySuccess}</p>
              <div className="rounded-md border border-border bg-background p-3">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                  New Recovery Key
                </p>
                <p className="font-mono text-sm text-foreground select-all break-all">
                  {newRecoveryKey}
                </p>
              </div>
              <Button
                className="w-full"
                onClick={() => {
                  setShowRecovery(false);
                  setNewRecoveryKey("");
                  setRecoveryKey("");
                  setNewPassword("");
                  setNewPin("");
                }}
              >
                Back to login
              </Button>
            </div>
          ) : (
            <form onSubmit={handleRecover} className="space-y-4">
              <div>
                <label className="text-xs text-muted-foreground">Recovery Key</label>
                <Input
                  value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)}
                  placeholder="ABCD-1234-EFGH-5678-..."
                  className="mt-1 font-mono"
                />
              </div>
              {authMethod === "password" && (
                <>
                  <div>
                    <label className="text-xs text-muted-foreground">New Username</label>
                    <Input
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">New Password</label>
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                </>
              )}
              {authMethod === "pin" && (
                <div>
                  <label className="text-xs text-muted-foreground">New PIN</label>
                  <Input
                    type="password"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value)}
                    className="mt-1"
                  />
                </div>
              )}
              {recoveryError && (
                <p className="text-xs text-destructive">{recoveryError}</p>
              )}
              <Button type="submit" className="w-full">
                Reset
              </Button>
              <button
                type="button"
                onClick={() => setShowRecovery(false)}
                className="w-full text-xs text-muted-foreground hover:text-foreground"
              >
                Back to login
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-border/50 bg-card/80 p-8 backdrop-blur-xl">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-foreground">chvor</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {authMethod === "password" ? "Enter your credentials" : "Enter your PIN"}
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          {authMethod === "password" && (
            <>
              <div>
                <label className="text-xs text-muted-foreground">Username</label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1"
                />
              </div>
            </>
          )}
          {authMethod === "pin" && (
            <div>
              <label className="text-xs text-muted-foreground">PIN / Passphrase</label>
              <Input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                autoFocus
                className="mt-1"
              />
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Logging in..." : "Login"}
          </Button>
        </form>

        <button
          onClick={() => setShowRecovery(true)}
          className="w-full text-xs text-muted-foreground hover:text-foreground"
        >
          Forgot password? Use recovery key
        </button>
      </div>
    </div>
  );
}
