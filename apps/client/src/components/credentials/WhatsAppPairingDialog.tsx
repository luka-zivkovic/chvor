import { useEffect, useRef } from "react";
import { useWhatsAppStore } from "../../stores/whatsapp-store";
import { useCredentialStore } from "../../stores/credential-store";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/ProviderIcon";

interface Props {
  onClose: () => void;
}

export function WhatsAppPairingDialog({ onClose }: Props) {
  const { status, phoneNumber, qrDataUrl, connect, disconnect, fetchStatus } =
    useWhatsAppStore();
  const { addCredential } = useCredentialStore();
  const credCreated = useRef(false);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // When status transitions to "connected", create a credential entry and close
  useEffect(() => {
    if (status === "connected" && !credCreated.current) {
      credCreated.current = true;
      const createCred = async () => {
        try {
          const summary = await api.credentials.create({
            name: `WhatsApp (${phoneNumber ?? "connected"})`,
            type: "whatsapp",
            data: { phoneNumber: phoneNumber ?? "" },
          });
          addCredential(summary);
        } catch {
          // Credential may already exist — that's fine
        }
      };
      createCred();
    }
  }, [status, phoneNumber, addCredential]);

  const handleConnect = async () => {
    try {
      await connect();
    } catch (err) {
      console.error("[whatsapp] connect failed:", err);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
    } catch (err) {
      console.error("[whatsapp] disconnect failed:", err);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-scale-in w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-4 flex items-center gap-2">
          <ProviderIcon icon="whatsapp" size={20} className="text-green-500" />
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            WhatsApp
          </h2>
        </div>

        {/* Disconnected — show connect button */}
        {status === "disconnected" && (
          <div className="flex flex-col items-center gap-4 py-4">
            <p className="text-center text-xs text-muted-foreground">
              Pair your WhatsApp account by scanning a QR code.
            </p>
            <Button onClick={handleConnect} size="sm">
              Connect WhatsApp
            </Button>
          </div>
        )}

        {/* Connecting — show QR code or waiting */}
        {status === "connecting" && (
          <div className="flex flex-col items-center gap-4 py-4">
            {qrDataUrl ? (
              <>
                <div className="rounded-lg border border-border bg-white p-2">
                  <img
                    src={qrDataUrl}
                    alt="WhatsApp QR Code"
                    className="h-48 w-48"
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  Open WhatsApp on your phone &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
                </p>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-6">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
                <p className="text-[10px] text-muted-foreground">
                  Generating QR code...
                </p>
              </div>
            )}
          </div>
        )}

        {/* Connected — show success */}
        {status === "connected" && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
              <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="text-green-500">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">Connected</p>
              {phoneNumber && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  +{phoneNumber}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              className="text-[10px] text-destructive hover:text-destructive"
            >
              Disconnect
            </Button>
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-[10px]">
            {status === "connected" ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </div>
  );
}
