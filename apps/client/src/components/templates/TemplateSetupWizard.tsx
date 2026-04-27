import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AddCredentialDialog } from "@/components/credentials/AddCredentialDialog";
import { useFeatureStore } from "@/stores/feature-store";
import type { TemplateManifest, TemplateCredentialDef } from "@chvor/shared";

type Step = "overview" | "credentials" | "done";

interface Props {
  template: TemplateManifest;
  includes?: string[];
  onComplete: () => void | Promise<void>;
  onCancel: () => void;
}

export function TemplateSetupWizard({ template, includes, onComplete, onCancel }: Props) {
  const { credentials, fetchCredentials } = useFeatureStore();
  const [step, setStep] = useState<Step>("overview");
  const [setupCredType, setSetupCredType] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  useEffect(() => { fetchCredentials(); }, [fetchCredentials]);

  // Close on Escape — but not when credential dialog is open (it has its own Escape handler)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !setupCredType) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, setupCredType]);

  const credTypeSet = new Set(credentials.map((c) => c.type));
  const requiredCreds = template.credentials ?? [];
  const missingCreds = requiredCreds.filter((c) => !credTypeSet.has(c.type));
  const allCredsConfigured = missingCreds.length === 0;

  const hasCredentialRequirements = requiredCreds.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Step 1: Overview */}
        {step === "overview" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">{template.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
              {template.author && (
                <p className="mt-1 text-[10px] text-muted-foreground/60">by {template.author}</p>
              )}
            </div>

            {/* What this template will configure */}
            <div className="space-y-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                This template will configure
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {template.persona && <Badge variant="secondary" className="text-[10px]">Persona</Badge>}
                {template.skillOverrides?.length && <Badge variant="secondary" className="text-[10px]">{template.skillOverrides.length} skill override(s)</Badge>}
                {requiredCreds.length > 0 && <Badge variant="secondary" className="text-[10px]">{requiredCreds.length} integration(s)</Badge>}
                {template.schedules?.length && <Badge variant="secondary" className="text-[10px]">{template.schedules.length} schedule(s)</Badge>}
                {template.pipeline && <Badge variant="secondary" className="text-[10px]">Pipeline</Badge>}
              </div>
            </div>

            {/* Included skills/tools */}
            {includes?.length ? (
              <div className="space-y-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Included skills &amp; tools
                </h3>
                <div className="flex flex-wrap gap-1">
                  {includes.map((id) => (
                    <Badge key={id} variant="outline" className="text-[9px] font-mono px-1.5 py-0">
                      {id}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
              <Button size="sm" onClick={() => setStep(hasCredentialRequirements ? "credentials" : "done")}>
                {hasCredentialRequirements ? "Next" : "Activate"}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Credentials */}
        {step === "credentials" && !setupCredType && (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Set up integrations</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                This template requires the following integrations. Set up any that are missing.
              </p>
            </div>

            <div className="space-y-2">
              {requiredCreds.map((cred: TemplateCredentialDef) => {
                const configured = credTypeSet.has(cred.type);
                return (
                  <div
                    key={cred.type}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                      configured
                        ? "border-green-500/20 bg-green-500/5"
                        : "border-border/50 bg-card/30"
                    }`}
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">{cred.name}</p>
                      <p className="text-[10px] text-muted-foreground">{cred.description}</p>
                    </div>
                    {configured ? (
                      <span className="text-[10px] text-green-400">Active</span>
                    ) : (
                      <Button size="sm" variant="outline" className="text-[10px]" onClick={() => setSetupCredType(cred.type)}>
                        Set up
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-[10px] text-muted-foreground">
                {requiredCreds.length - missingCreds.length}/{requiredCreds.length} configured
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setStep("overview")}>Back</Button>
                <Button size="sm" onClick={() => setStep("done")} disabled={!allCredsConfigured}>
                  {allCredsConfigured ? "Activate" : "Set up all to continue"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Inline credential setup */}
        {step === "credentials" && setupCredType && (
          <AddCredentialDialog
            initialCredType={setupCredType}
            onClose={() => { setSetupCredType(null); fetchCredentials(); }}
          />
        )}

        {/* Step 3: Done */}
        {step === "done" && (
          <div className="space-y-4 text-center">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Ready to activate</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {template.name} will be applied to your assistant. You can uninstall it later to restore your previous configuration.
              </p>
            </div>
            {activateError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-[10px] text-destructive">{activateError}</p>
              </div>
            )}
            <div className="flex justify-center gap-2 pt-2">
              <Button variant="outline" size="sm" disabled={activating} onClick={() => setStep(hasCredentialRequirements ? "credentials" : "overview")}>Back</Button>
              <Button
                size="sm"
                disabled={activating}
                onClick={async () => {
                  setActivating(true);
                  setActivateError(null);
                  try {
                    await onComplete();
                  } catch (err) {
                    setActivateError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setActivating(false);
                  }
                }}
              >
                {activating ? "Activating..." : "Activate Template"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
