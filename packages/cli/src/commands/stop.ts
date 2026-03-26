import { stopServer } from "../lib/process.js";

export async function stop(): Promise<void> {
  await stopServer();
}
