export type Platform = "linux" | "darwin" | "win";
export type Arch = "x64" | "arm64";

export function getPlatform(): Platform {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    case "win32":
      return "win";
    default:
      throw new Error(
        `Unsupported platform: "${process.platform}". Chvor supports linux, darwin (macOS), and win32 (Windows).`
      );
  }
}

export function getArch(): Arch {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(
        `Unsupported architecture: "${process.arch}". Chvor supports x64 and arm64.`
      );
  }
}

export function getAssetName(version: string): string {
  const os = getPlatform();
  const arch = getArch();
  const ext = os === "win" ? "zip" : "tar.gz";
  return `chvor-v${version}-${os}-${arch}.${ext}`;
}
