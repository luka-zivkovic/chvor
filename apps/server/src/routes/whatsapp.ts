import { Hono } from "hono";
import { getGatewayInstance } from "../gateway/gateway-instance.ts";
import type { WhatsAppChannel } from "../channels/whatsapp.ts";

const whatsapp = new Hono();

function getWhatsAppChannel(): WhatsAppChannel | null {
  const gw = getGatewayInstance();
  if (!gw) return null;
  return (gw.getChannel("whatsapp") as WhatsAppChannel) ?? null;
}

// GET /api/whatsapp/status — connection status
whatsapp.get("/status", (c) => {
  const channel = getWhatsAppChannel();
  if (!channel) {
    return c.json({ data: { status: "disconnected" } });
  }
  return c.json({ data: channel.getStatus() });
});

// POST /api/whatsapp/connect — initiate QR pairing
whatsapp.post("/connect", async (c) => {
  const channel = getWhatsAppChannel();
  if (!channel) {
    return c.json({ error: "WhatsApp channel not registered" }, 500);
  }

  const { status } = channel.getStatus();
  if (status === "connected") {
    return c.json({ data: { status: "connected", message: "Already connected" } });
  }

  try {
    await channel.connect();
    return c.json({ data: { status: "connecting", message: "QR code will be sent via WebSocket" } });
  } catch (err) {
    console.error("[api] POST /whatsapp/connect error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/whatsapp/disconnect — disconnect and clear auth
whatsapp.post("/disconnect", async (c) => {
  const channel = getWhatsAppChannel();
  if (!channel) {
    return c.json({ error: "WhatsApp channel not registered" }, 500);
  }

  try {
    await channel.disconnect();
    return c.json({ data: { status: "disconnected" } });
  } catch (err) {
    console.error("[api] POST /whatsapp/disconnect error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

export default whatsapp;
