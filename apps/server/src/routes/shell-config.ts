import { Hono } from "hono";
import type { UpdateShellConfigRequest, ShellApprovalMode } from "@chvor/shared";
import { getShellConfig, updateShellConfig } from "../db/config-store.ts";

const VALID_MODES: ShellApprovalMode[] = ["always_approve", "moderate_plus", "dangerous_only", "block_all"];

const shellConfig = new Hono();

shellConfig.get("/", (c) => {
  return c.json({ data: getShellConfig() });
});

shellConfig.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpdateShellConfigRequest;
    if (body.approvalMode !== undefined && !VALID_MODES.includes(body.approvalMode)) {
      return c.json({ error: `approvalMode must be one of: ${VALID_MODES.join(", ")}` }, 400);
    }
    const updated = updateShellConfig(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default shellConfig;
