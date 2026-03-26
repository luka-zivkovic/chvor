import type { Gateway } from "./gateway.ts";

let instance: Gateway | null = null;

export function setGatewayInstance(gw: Gateway): void {
  instance = gw;
}

export function getGatewayInstance(): Gateway | null {
  return instance;
}
