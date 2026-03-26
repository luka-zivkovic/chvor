import { Hono } from "hono";
import type { UpdatePersonaRequest } from "@chvor/shared";
import { getPersona, updatePersona } from "../db/config-store.ts";

const persona = new Hono();

persona.get("/", (c) => {
  try {
    return c.json({ data: getPersona() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

persona.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpdatePersonaRequest;
    if (body.communicationStyle !== undefined &&
        !["concise", "balanced", "detailed", ""].includes(body.communicationStyle)) {
      return c.json({ error: "Invalid communicationStyle" }, 400);
    }
    if (body.exampleResponses) {
      body.exampleResponses = body.exampleResponses
        .filter((ex: { user?: string; assistant?: string }) => ex.user?.trim() && ex.assistant?.trim())
        .slice(0, 5);
    }
    const updated = updatePersona(body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default persona;
