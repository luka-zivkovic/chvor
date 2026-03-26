import { useState } from "react";
import type { CredentialSummary } from "@chvor/shared";
import { useCredentialStore } from "../../stores/credential-store";
import { api } from "../../lib/api";
import { StatusBadge } from "./StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  credential: CredentialSummary;
  onEdit?: (credential: CredentialSummary) => void;
}

function getAccentBorder(status?: string): string {
  if (status === "success") return "border-l-green-500/60";
  if (status === "failed") return "border-l-red-500/60";
  return "border-l-border";
}

export function CredentialCard({ credential, onEdit }: Props) {
  const { removeCredential, updateCredential } = useCredentialStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testing, setTesting] = useState(false);

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await api.credentials.delete(credential.id);
      removeCredential(credential.id);
    } catch {
      setConfirmDelete(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await api.credentials.testSaved(credential.id);
      updateCredential(credential.id, {
        testStatus: result.success ? "success" : "failed",
      });
    } catch (err) {
      console.error("Credential test failed:", err);
      updateCredential(credential.id, { testStatus: "failed" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className={cn("border-l-2 transition-colors hover:border-border/80", getAccentBorder(credential.testStatus))}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {credential.type}
              </span>
              <StatusBadge status={credential.testStatus} />
            </div>
            <p className="truncate text-sm font-medium">{credential.name}</p>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
              {Object.entries(credential.redactedFields).map(([k, v]) => (
                <span
                  key={k}
                  className="font-mono text-[10px] text-muted-foreground"
                >
                  {k}: {v}
                </span>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleTest}
              disabled={testing}
              className="h-auto px-2 py-1 text-[10px]"
            >
              {testing ? "..." : "Test"}
            </Button>
            {onEdit && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onEdit(credential)}
                className="h-auto px-2 py-1 text-[10px]"
              >
                Edit
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit?.(credential)}
              className="h-auto px-2 py-1 text-[10px]"
            >
              Edit
            </Button>
            <Button
              variant={confirmDelete ? "destructive" : "ghost"}
              size="sm"
              onClick={handleDelete}
              onBlur={() => setConfirmDelete(false)}
              className="h-auto px-2 py-1 text-[10px]"
            >
              {confirmDelete ? "Confirm?" : "Del"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
