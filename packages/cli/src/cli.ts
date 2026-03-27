import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));

const program = new Command()
  .name("chvor")
  .description("Your own AI — install and run chvor.")
  .version(pkg.version);

program
  .action(async () => {
    const { isOnboarded } = await import("./lib/config.js");
    if (!isOnboarded()) {
      const { onboard } = await import("./commands/onboard.js");
      await onboard();
    } else {
      const { start } = await import("./commands/start.js");
      await start({});
    }
  });

program
  .command("start")
  .description("Start the chvor server")
  .option("-p, --port <port>", "Server port")
  .option("--foreground", "Run in foreground (no detach)")
  .option("-i, --instance <name>", "Named instance to start")
  .action(async (opts) => {
    if (opts.instance) {
      const { setInstance } = await import("./lib/paths.js");
      setInstance(opts.instance);
    }
    if (opts.port) {
      const { validatePort } = await import("./lib/validate.js");
      validatePort(opts.port);
    }
    const { start } = await import("./commands/start.js");
    await start(opts);
  });

program
  .command("stop")
  .description("Stop the running chvor server")
  .option("-i, --instance <name>", "Named instance to stop")
  .action(async (opts) => {
    if (opts.instance) {
      const { setInstance } = await import("./lib/paths.js");
      setInstance(opts.instance);
    }
    const { stop } = await import("./commands/stop.js");
    await stop();
  });

program
  .command("init")
  .description("Set up a new agent from a template")
  .option("-t, --template <name>", "Template name or ID")
  .option("-n, --name <instance>", "Instance name for multi-instance support")
  .option("--from <path>", "Local template directory path")
  .action(async (opts) => {
    const { init } = await import("./commands/init.js");
    await init(opts);
  });

const instancesCmd = program
  .command("instances")
  .description("Manage chvor instances");

instancesCmd
  .action(async () => {
    const { listInstances } = await import("./commands/instances.js");
    await listInstances();
  });

instancesCmd
  .command("start <name>")
  .description("Start a named instance")
  .action(async (name: string) => {
    const { startInstance } = await import("./commands/instances.js");
    await startInstance(name);
  });

instancesCmd
  .command("stop <name>")
  .description("Stop a named instance")
  .action(async (name: string) => {
    const { stopInstance } = await import("./commands/instances.js");
    await stopInstance(name);
  });

program
  .command("onboard")
  .description("Interactive first-time setup wizard")
  .action(async () => {
    const { onboard } = await import("./commands/onboard.js");
    await onboard();
  });

program
  .command("update")
  .description("Update to the latest chvor release")
  .action(async () => {
    const { update } = await import("./commands/update.js");
    await update();
  });

program
  .command("docker")
  .description("Pull and run chvor as a Docker container")
  .option("-p, --port <port>", "Host port", "3001")
  .action(async (opts) => {
    const { docker } = await import("./commands/docker.js");
    await docker(opts);
  });

const skillCmd = program
  .command("skill")
  .description("Manage skills from the community registry");

skillCmd
  .command("search <query>")
  .description("Search the skill registry")
  .action(async (query: string) => {
    const { skillSearch } = await import("./commands/skill.js");
    await skillSearch(query);
  });

skillCmd
  .command("install <name>")
  .description("Install a skill from the registry")
  .action(async (name: string) => {
    const { skillInstall } = await import("./commands/skill.js");
    await skillInstall(name);
  });

skillCmd
  .command("uninstall <name>")
  .description("Uninstall a registry skill")
  .action(async (name: string) => {
    const { skillUninstall } = await import("./commands/skill.js");
    await skillUninstall(name);
  });

skillCmd
  .command("update [name]")
  .description("Update one or all registry skills")
  .action(async (name?: string) => {
    const { skillUpdate } = await import("./commands/skill.js");
    await skillUpdate(name);
  });

skillCmd
  .command("list")
  .description("List all installed skills")
  .action(async () => {
    const { skillList } = await import("./commands/skill.js");
    await skillList();
  });

skillCmd
  .command("info <name>")
  .description("Show details for a registry skill")
  .action(async (name: string) => {
    const { skillInfo } = await import("./commands/skill.js");
    await skillInfo(name);
  });

skillCmd
  .command("publish <path>")
  .description("Validate a skill file for publishing")
  .action(async (path: string) => {
    const { skillPublish } = await import("./commands/skill.js");
    await skillPublish(path);
  });

const toolCmd = program
  .command("tool")
  .description("Manage tools from the community registry");

toolCmd
  .command("search <query>")
  .description("Search the tool registry")
  .action(async (query: string) => {
    const { toolSearch } = await import("./commands/skill.js");
    await toolSearch(query);
  });

toolCmd
  .command("install <name>")
  .description("Install a tool from the registry")
  .action(async (name: string) => {
    const { toolInstall } = await import("./commands/skill.js");
    await toolInstall(name);
  });

toolCmd
  .command("uninstall <name>")
  .description("Uninstall a registry tool")
  .action(async (name: string) => {
    const { toolUninstall } = await import("./commands/skill.js");
    await toolUninstall(name);
  });

toolCmd
  .command("update [name]")
  .description("Update one or all registry tools")
  .action(async (name?: string) => {
    const { toolUpdate } = await import("./commands/skill.js");
    await toolUpdate(name);
  });

toolCmd
  .command("list")
  .description("List all installed tools")
  .action(async () => {
    const { toolList } = await import("./commands/skill.js");
    await toolList();
  });

toolCmd
  .command("info <name>")
  .description("Show details for a registry tool")
  .action(async (name: string) => {
    const { toolInfo } = await import("./commands/skill.js");
    await toolInfo(name);
  });

toolCmd
  .command("publish <path>")
  .description("Validate and publish a tool file")
  .action(async (path: string) => {
    const { toolPublish } = await import("./commands/skill.js");
    await toolPublish(path);
  });

program
  .command("open")
  .description("Open chvor in your default browser")
  .action(async () => {
    const { open } = await import("./commands/open.js");
    await open();
  });

const serviceCmd = program
  .command("service")
  .description("Manage auto-start on login");

serviceCmd
  .command("install")
  .description("Enable auto-start on login")
  .option("-i, --instance <name>", "Named instance")
  .action(async (opts: { instance?: string }) => {
    const { serviceInstall } = await import("./commands/service.js");
    await serviceInstall(opts);
  });

serviceCmd
  .command("uninstall")
  .description("Disable auto-start on login")
  .option("-i, --instance <name>", "Named instance")
  .action(async (opts: { instance?: string }) => {
    const { serviceUninstall } = await import("./commands/service.js");
    await serviceUninstall(opts);
  });

serviceCmd
  .command("status")
  .description("Check auto-start status")
  .option("-i, --instance <name>", "Named instance")
  .action(async (opts: { instance?: string }) => {
    const { serviceStatus } = await import("./commands/service.js");
    await serviceStatus(opts);
  });

const authCmd = program
  .command("auth")
  .description("Manage authentication");

authCmd
  .command("reset")
  .description("Reset authentication credentials (requires access to data directory)")
  .option("-i, --instance <name>", "Named instance to reset")
  .action(async (opts: { instance?: string }) => {
    if (opts.instance) {
      const { setInstance } = await import("./lib/paths.js");
      setInstance(opts.instance);
    }
    const { authReset } = await import("./commands/auth.js");
    await authReset();
  });

await program.parseAsync(process.argv);
