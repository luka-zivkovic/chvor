use std::process::Command;

/// On macOS, GUI apps launched from Finder/Spotlight don't inherit the user's
/// shell PATH (`.zshrc` / `.bashrc` are never sourced).  This means Homebrew
/// (`/opt/homebrew/bin`) and anything installed through it (node, brew, etc.)
/// is invisible to the process.
///
/// Fix: spawn the user's login shell once, grab the real PATH, and inject it
/// into this process.  Technique borrowed from coollabsio/jean.
#[cfg(target_os = "macos")]
fn fix_macos_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let output = Command::new(&shell)
        .args(["-l", "-c", "/usr/bin/printenv PATH"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                // Filter out /Volumes/ paths to prevent macOS TCC permission
                // dialogs for removable media.
                let filtered: String = path
                    .split(':')
                    .filter(|p| !p.contains("/Volumes/"))
                    .collect::<Vec<_>>()
                    .join(":");
                // SAFETY: called exactly once from `ensure_path` behind a
                // `std::sync::Once` guard — no data race.
                #[allow(deprecated)]
                std::env::set_var("PATH", &filtered);
            }
        }
    }
}

/// Lazy, once-only PATH initialisation.  Call before any CLI invocation on
/// macOS; no-op on other platforms.
#[cfg(target_os = "macos")]
pub fn ensure_path() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(fix_macos_path);
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_path() {}

/// Cross-platform command wrapper.
///
/// - **macOS**: ensures the shell PATH has been loaded (Homebrew, nvm, etc.)
/// - **Windows**: sets `CREATE_NO_WINDOW` so spawning node/brew doesn't flash
///   a console window.
pub fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    ensure_path();

    #[allow(unused_mut)]
    let mut cmd = Command::new(program);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}
