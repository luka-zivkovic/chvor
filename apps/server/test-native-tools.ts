import { getNativeToolDefinitions, isNativeTool, callNativeTool } from "./src/lib/native-tools.ts";

const defs = getNativeToolDefinitions();
console.log("Native tools:", Object.keys(defs));
console.log("isNativeTool(native__web_request):", isNativeTool("native__web_request"));
console.log("isNativeTool(fake):", isNativeTool("fake"));

// Test actual fetch
try {
  const r = await callNativeTool("native__web_request", { url: "https://httpbin.org/get" });
  console.log("Fetch status line:", r.content[0].text.split("\n")[0]);
  console.log("SUCCESS");
} catch (e: any) {
  console.error("FAIL:", e.message);
}
