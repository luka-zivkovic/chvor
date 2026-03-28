import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import SetupWizard from "./pages/SetupWizard";
import Dashboard from "./pages/Dashboard";

interface ChvorConfig {
  installedVersion?: string;
  port: string;
  token?: string;
  onboarded: boolean;
  llmProvider?: string;
  instanceName?: string;
  templateName?: string;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [onboarded, setOnboarded] = useState(false);

  useEffect(() => {
    invoke<ChvorConfig>("read_config", { instance: null })
      .then(async (config) => {
        const isConfigured = config.onboarded && !!config.installedVersion;

        if (isConfigured) {
          // Verify the install actually exists — stale config from a previous
          // version could claim onboarded but have no binary.
          const installed = await invoke<boolean>("is_installed", {
            version: config.installedVersion,
          });
          setOnboarded(installed);
        } else {
          setOnboarded(false);
        }
      })
      .catch(() => setOnboarded(false))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!onboarded) {
    return <SetupWizard onComplete={() => setOnboarded(true)} />;
  }

  return <Dashboard />;
}
