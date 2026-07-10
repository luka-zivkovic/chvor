import { useState } from "react";
import { VoiceSettingsContent } from "./VoiceSettingsContent";
import { cn } from "@/lib/utils";
import { BackupContent } from "./settings/BackupContent";
import { CredentialsContent } from "./settings/CredentialsContent";
import { SecurityContent } from "./settings/SecurityContent";
import { SessionsContent } from "./settings/SessionsContent";

type SettingsTab = "api-keys" | "voice" | "security" | "sessions" | "backup";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "api-keys", label: "API Keys" },
  { id: "voice", label: "Voice" },
  { id: "security", label: "Security" },
  { id: "sessions", label: "Sessions" },
  { id: "backup", label: "Backup" },
];

export { BackupContent, CredentialsContent, SecurityContent, SessionsContent };

export function SettingsPanel() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("api-keys");

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-border/50">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex-1 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.15em] transition-colors",
              activeTab === tab.id
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-5">
        {activeTab === "api-keys" && <CredentialsContent />}
        {activeTab === "voice" && <VoiceSettingsContent />}
        {activeTab === "security" && <SecurityContent />}
        {activeTab === "sessions" && <SessionsContent />}
        {activeTab === "backup" && <BackupContent />}
      </div>
    </div>
  );
}
