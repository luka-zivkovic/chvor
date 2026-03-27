import { useState } from "react";
import { useCanvasStore } from "../../stores/canvas-store";
import { useCredentialStore } from "../../stores/credential-store";
import { useUIStore } from "../../stores/ui-store";
import { useWhatsAppStore } from "../../stores/whatsapp-store";
import { StatusBadge } from "../credentials/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "../../lib/api";
import type { IntegrationNodeData } from "../../stores/canvas-store";
import { WhatsAppAccessControl } from "./WhatsAppAccessControl";

const CHANNEL_INFO: Record<string, { label: string; description: string }> = {
  telegram: { label: "Telegram Bot", description: "Receives and sends messages via Telegram" },
  discord: { label: "Discord Bot", description: "Receives and sends messages in Discord servers" },
  slack: { label: "Slack App", description: "Receives and sends messages via Slack Socket Mode" },
  whatsapp: { label: "WhatsApp", description: "Receives and sends messages via WhatsApp" },
};

function statusDotClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-status-running animate-pulse";
    case "completed":
      return "bg-status-completed";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

export function IntegrationDetailPanel() {
  const detailNodeId = useUIStore((s) => s.detailNodeId);
  const nodes = useCanvasStore((s) => s.nodes);
  const { credentials, providers, updateCredential, removeCredential } = useCredentialStore();
  const whatsappDisconnect = useWhatsAppStore((s) => s.disconnect);
  const closePanel = useUIStore((s) => s.closePanel);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const node = nodes.find((n) => n.id === detailNodeId);
  if (!node) return <p className="text-xs text-muted-foreground">Node not found</p>;

  const data = node.data as unknown as IntegrationNodeData;
  const credential = credentials.find((c) => c.id === data.credentialId);
  const channelInfo = CHANNEL_INFO[data.credentialType];
  const provider = providers.find((p) => p.credentialType === data.credentialType);

  const startEditing = () => {
    if (!credential) return;
    setEditing(true);
    setName(credential.name);
    setFields({});
    setTestResult(null);
    setError(null);
  };

  const cancelEditing = () => {
    setEditing(false);
    setFields({});
    setTestResult(null);
    setError(null);
  };

  const handleTest = async () => {
    if (!credential) return;
    setTesting(true);
    setTestResult(null);
    try {
      // If user filled new field values, test those; otherwise test saved credential
      const hasNewFields = Object.values(fields).some((v) => v.trim());
      if (hasNewFields && provider) {
        const result = await api.credentials.test({
          type: credential.type,
          data: fields,
        });
        setTestResult(result);
      } else {
        const result = await api.credentials.testSaved(credential.id);
        setTestResult(result);
        if (result.success) {
          updateCredential(credential.id, { testStatus: "success" });
        }
      }
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!credential) return;
    setSaving(true);
    setError(null);
    try {
      const hasNewFields = Object.values(fields).some((v) => v.trim());
      const body: { name?: string; data?: Record<string, string> } = {};
      if (name.trim() && name.trim() !== credential.name) body.name = name.trim();
      if (hasNewFields) body.data = fields;

      if (!body.name && !body.data) {
        // Nothing changed
        cancelEditing();
        return;
      }

      const updated = await api.credentials.update(credential.id, body);
      updateCredential(credential.id, updated);
      setEditing(false);
      setFields({});
      setTestResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!credential) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setRemoving(true);
    try {
      if (data.credentialType === "whatsapp") {
        await whatsappDisconnect();
      }
      await api.credentials.delete(credential.id);
      removeCredential(credential.id);
      closePanel();
    } catch {
      setConfirmRemove(false);
    } finally {
      setRemoving(false);
    }
  };

  if (editing && credential) {
    const requiredFields = provider?.requiredFields ?? [];

    return (
      <div className="flex flex-col gap-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Edit Integration
        </h3>

        {/* Name */}
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Name
          </Label>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Integration name"
          />
        </div>

        {/* Credential fields */}
        {requiredFields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {field.label}
            </Label>
            <Input
              type={field.type === "password" ? "password" : "text"}
              value={fields[field.key] ?? ""}
              onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={credential.redactedFields[field.key] ?? field.placeholder}
              className="font-mono"
            />
            <p className="text-[9px] text-muted-foreground/60">
              Leave empty to keep current value
            </p>
          </div>
        ))}

        {/* If no provider found, show generic field */}
        {requiredFields.length === 0 && (
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Token / API Key
            </Label>
            <Input
              type="password"
              value={fields["apiKey"] ?? ""}
              onChange={(e) => setFields((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={credential.redactedFields["apiKey"] ?? "Enter new value"}
              className="font-mono"
            />
            <p className="text-[9px] text-muted-foreground/60">
              Leave empty to keep current value
            </p>
          </div>
        )}

        {testResult && (
          <div
            className={`rounded-md px-3 py-2 text-[10px] ${
              testResult.success
                ? "bg-green-500/10 text-green-400"
                : "bg-red-500/10 text-red-400"
            }`}
          >
            {testResult.success ? "Connection OK" : `Failed: ${testResult.error}`}
          </div>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleTest}
            disabled={testing}
            className="text-[10px]"
          >
            {testing ? "Testing..." : "Test Connection"}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={cancelEditing}
              className="text-[10px]"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="text-[10px]"
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Connection Info */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connection
        </h3>
        <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
          <p className="text-sm font-medium">{channelInfo?.label ?? data.label}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {channelInfo?.description ?? `Integration via ${data.credentialType}`}
          </p>
        </div>
      </section>

      {/* Credential */}
      {credential && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Credential
          </h3>
          <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5">
            <span className="text-xs text-foreground/80">{credential.name}</span>
            <StatusBadge status={credential.testStatus} />
          </div>
        </section>
      )}

      {/* Execution Status */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Status
        </h3>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusDotClass(data.executionStatus)}`} />
          <span className="text-xs capitalize text-muted-foreground">
            {data.executionStatus}
          </span>
        </div>
      </section>

      {/* Access Control (WhatsApp only) */}
      {data.credentialType === "whatsapp" && <WhatsAppAccessControl />}

      {/* Actions */}
      {credential && (
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={startEditing}
            className="w-full text-[10px]"
          >
            Edit
          </Button>
          <Button
            variant={confirmRemove ? "destructive" : "outline"}
            size="sm"
            onClick={handleRemove}
            onBlur={() => setConfirmRemove(false)}
            disabled={removing}
            className="w-full text-[10px]"
          >
            {removing ? "Removing..." : confirmRemove ? "Confirm removal?" : "Remove Integration"}
          </Button>
        </div>
      )}
    </div>
  );
}
