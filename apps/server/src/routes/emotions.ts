import { Hono } from "hono";
import {
  getSessionEmotionArc,
  getLatestEmotion,
  getEmotionHistory,
  getEmotionPatterns,
} from "../db/emotion-store.ts";

const emotionsRoute = new Hono();

// Note: all /api/* routes are protected by chvorAuth middleware (see index.ts).
// Session ownership validation is not needed in single-user mode but should be
// added if multi-user support is introduced.

// GET /api/emotions/current/:sessionId — latest snapshot for a session
emotionsRoute.get("/current/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const snapshot = getLatestEmotion(sessionId);
  return c.json({ data: snapshot });
});

// GET /api/emotions/session/:sessionId — full session arc
emotionsRoute.get("/session/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const arc = getSessionEmotionArc(sessionId);
  return c.json(arc);
});

// GET /api/emotions/history — cross-session history
emotionsRoute.get("/history", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "100") || 100, 1), 500);
  const history = getEmotionHistory(limit);
  return c.json({ data: history });
});

// GET /api/emotions/patterns — emotion frequency/pattern data
emotionsRoute.get("/patterns", (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "30") || 30, 1), 365);
  const patterns = getEmotionPatterns(days);
  return c.json(patterns);
});

export default emotionsRoute;
