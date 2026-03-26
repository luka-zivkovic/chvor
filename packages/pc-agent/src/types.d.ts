declare module "screenshot-desktop" {
  function screenshot(opts?: { format?: "png" | "jpg" }): Promise<Buffer>;
  export default screenshot;
}
