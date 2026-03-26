import { create } from "zustand";
import { api } from "../lib/api";

type WhatsAppStatus = "disconnected" | "connecting" | "connected";

interface WhatsAppState {
  status: WhatsAppStatus;
  phoneNumber: string | undefined;
  qrDataUrl: string | null;

  setQR: (qrDataUrl: string) => void;
  setStatus: (status: WhatsAppStatus, phoneNumber?: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  fetchStatus: () => Promise<void>;
}

export const useWhatsAppStore = create<WhatsAppState>((set) => ({
  status: "disconnected",
  phoneNumber: undefined,
  qrDataUrl: null,

  setQR: (qrDataUrl) => set({ qrDataUrl }),

  setStatus: (status, phoneNumber) =>
    set({
      status,
      phoneNumber,
      // Clear QR when connected or disconnected
      ...(status !== "connecting" ? { qrDataUrl: null } : {}),
    }),

  connect: async () => {
    set({ status: "connecting", qrDataUrl: null });
    await api.whatsapp.connect();
  },

  disconnect: async () => {
    await api.whatsapp.disconnect();
    set({ status: "disconnected", phoneNumber: undefined, qrDataUrl: null });
  },

  fetchStatus: async () => {
    try {
      const data = await api.whatsapp.status();
      set({ status: data.status, phoneNumber: data.phoneNumber });
    } catch {
      // Ignore — server might not be reachable
    }
  },
}));
