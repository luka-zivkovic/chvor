import type { WSManager } from "./ws.ts";

let instance: WSManager | null = null;

export function setWSInstance(ws: WSManager): void { instance = ws; }
export function getWSInstance(): WSManager | null { return instance; }
