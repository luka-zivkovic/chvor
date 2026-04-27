import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { WorkspacePage } from "./pages/WorkspacePage";
import { OnboardingExperience } from "./components/onboarding/OnboardingExperience";
import { useConfigStore } from "./stores/config-store";
import { useSessionStore } from "./stores/session-store";
import { LoginPage } from "./pages/LoginPage";
import { ErrorBoundary } from "./components/ErrorBoundary";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { authEnabled, authenticated, checkStatus } = useSessionStore();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    checkStatus().then(() => setChecked(true));
  }, [checkStatus]);

  if (!checked) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  // Auth not enabled — pass through, no login needed
  if (!authEnabled) return <>{children}</>;

  // Auth enabled but not logged in — show login
  if (!authenticated) return <LoginPage />;

  return <>{children}</>;
}

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { persona, fetchPersona } = useConfigStore();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetchPersona().then(() => setChecked(true));
  }, [fetchPersona]);

  useEffect(() => {
    if (checked && persona && !persona.onboarded) {
      setShowOnboarding(true);
    }
  }, [checked, persona]);

  return (
    <>
      {showOnboarding && (
        <OnboardingExperience onComplete={() => setShowOnboarding(false)} />
      )}
      {children}
    </>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AuthGate>
        <OnboardingGate>
          <WorkspacePage />
          <Toaster
            theme="dark"
            position="bottom-right"
            richColors
            toastOptions={{
              className:
                "!backdrop-blur-xl !bg-card/80 !border-border !text-foreground",
            }}
          />
        </OnboardingGate>
      </AuthGate>
    </ErrorBoundary>
  );
}
