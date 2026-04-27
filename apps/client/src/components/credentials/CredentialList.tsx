import { useState } from "react";
import type { CredentialSummary } from "@chvor/shared";
import { useFeatureStore } from "../../stores/feature-store";
import { CredentialCard } from "./CredentialCard";
import { AddCredentialDialog } from "./AddCredentialDialog";

interface Props {
  onEdit?: (credential: CredentialSummary) => void;
}

export function CredentialList({ onEdit }: Props) {
  const { credentials } = useFeatureStore();
  const [editingCredential, setEditingCredential] = useState<CredentialSummary | null>(null);

  if (credentials.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/50">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <p className="text-[11px] text-muted-foreground">
          No credentials. Add a provider to get started.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {credentials.map((cred) => (
          <CredentialCard
            key={cred.id}
            credential={cred}
            onEdit={setEditingCredential}
          />
        ))}
      </div>
      {editingCredential && (
        <AddCredentialDialog
          onClose={() => setEditingCredential(null)}
          editCredential={editingCredential}
        />
      )}
    </>
  );
}
