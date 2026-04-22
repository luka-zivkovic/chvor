// Thin re-export shim. The implementation lives in ./native-tools/.
// This file exists to preserve the historical import path:
//   import { ... } from "./native-tools.ts";
// New code should prefer importing directly from "./native-tools/index.ts"
// (or the relevant submodule) when behaviorally appropriate.
export * from "./native-tools/index.ts";
