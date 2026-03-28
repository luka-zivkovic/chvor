param(
    [switch]$Docker
)

$ErrorActionPreference = "Stop"

Write-Host "Installing chvor..." -ForegroundColor Cyan

# ── Helpers ──────────────────────────────────────────────────────────

function Test-NodeVersion {
    try {
        $raw = & node -v 2>$null
        if (-not $raw) { return $false }
        $ver = $raw -replace '^v', ''
        $major = [int]($ver.Split('.')[0])
        return ($major -ge 22)
    }
    catch {
        return $false
    }
}

# ── Docker mode ──────────────────────────────────────────────────────

if ($Docker) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "Error: Docker is not installed." -ForegroundColor Red
        Write-Host "Install Docker from https://docs.docker.com/get-docker/ and try again."
        exit 1
    }

    Write-Host "Pulling chvor Docker image..."
    docker pull ghcr.io/luka-zivkovic/chvor:latest

    Write-Host "Starting chvor container..."
    docker run -d `
        --name chvor `
        -p 9147:9147 `
        -v "chvor-data:/data" `
        ghcr.io/luka-zivkovic/chvor:latest

    Write-Host ""
    Write-Host "chvor is running!" -ForegroundColor Green
    Write-Host "Open http://localhost:9147 in your browser."
    exit 0
}

# ── Standard (npm) install ───────────────────────────────────────────

if (-not (Test-NodeVersion)) {
    Write-Host "Node.js >= 22 not found. Attempting to install..." -ForegroundColor Yellow

    $installed = $false

    # Try winget first
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "Installing Node.js via winget..."
        try {
            winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
            $installed = $true
        }
        catch {
            Write-Host "winget installation failed, trying alternatives..." -ForegroundColor Yellow
        }
    }

    # Try Chocolatey
    if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) {
        Write-Host "Installing Node.js via Chocolatey..."
        try {
            choco install nodejs-lts -y
            $installed = $true
        }
        catch {
            Write-Host "Chocolatey installation failed, trying alternatives..." -ForegroundColor Yellow
        }
    }

    # Try Scoop
    if (-not $installed -and (Get-Command scoop -ErrorAction SilentlyContinue)) {
        Write-Host "Installing Node.js via Scoop..."
        try {
            scoop install nodejs-lts
            $installed = $true
        }
        catch {
            Write-Host "Scoop installation failed." -ForegroundColor Yellow
        }
    }

    if (-not $installed) {
        Write-Host "Error: Could not install Node.js automatically." -ForegroundColor Red
        Write-Host "Install Node.js 22+ from https://nodejs.org and re-run this script."
        exit 1
    }

    # Refresh PATH so the current session sees the new node binary
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# Verify node is available and meets the version requirement
if (-not (Test-NodeVersion)) {
    Write-Host "Error: Node.js 22+ is still not available after installation attempt." -ForegroundColor Red
    Write-Host "Please install Node.js 22+ manually from https://nodejs.org and re-run this script."
    exit 1
}

$nodeVer = & node -v
Write-Host "Node.js $nodeVer detected."

Write-Host "Installing chvor globally via npm..."
npm install -g @chvor/cli

Write-Host ""
Write-Host "chvor installed successfully!" -ForegroundColor Green
Write-Host "Run 'chvor' to complete setup."
