#!/usr/bin/env bash
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BOLD}Installing chvor...${NC}"

# ── Helpers ──────────────────────────────────────────────────────────

check_node() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local ver
  ver="$(node -v | sed 's/^v//')"
  local major
  major="$(echo "$ver" | cut -d. -f1)"
  if [ "$major" -ge 22 ]; then
    return 0
  fi
  return 1
}

install_node() {
  echo -e "${BOLD}Node.js >= 22 not found. Installing...${NC}"

  case "$(uname -s)" in
    Darwin)
      if command -v brew &>/dev/null; then
        echo "Using Homebrew to install Node.js 22..."
        brew install node@22
        brew link --overwrite node@22 2>/dev/null || true
      else
        echo -e "${RED}Homebrew not found.${NC}"
        echo "Install Node.js 22+ manually from https://nodejs.org and re-run this script."
        exit 1
      fi
      ;;
    Linux)
      if command -v apt-get &>/dev/null; then
        echo "Using NodeSource to install Node.js 22..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
      else
        echo -e "${RED}Non-Debian Linux detected.${NC}"
        echo "Install Node.js 22+ manually from https://nodejs.org and re-run this script."
        exit 1
      fi
      ;;
    *)
      echo -e "${RED}Unsupported OS: $(uname -s)${NC}"
      exit 1
      ;;
  esac
}

# ── Docker mode ──────────────────────────────────────────────────────

if [ "${1:-}" = "--docker" ]; then
  if ! command -v docker &>/dev/null; then
    echo -e "${RED}Error: docker is not installed.${NC}"
    echo "Install Docker from https://docs.docker.com/get-docker/ and try again."
    exit 1
  fi

  echo "Pulling chvor Docker image..."
  docker pull ghcr.io/luka-zivkovic/chvor:latest

  echo "Starting chvor container..."
  docker run -d \
    --name chvor \
    -p 3001:3001 \
    -v ~/.chvor:/home/node/.chvor \
    ghcr.io/luka-zivkovic/chvor:latest

  echo ""
  echo -e "${GREEN}${BOLD}chvor is running!${NC}"
  echo -e "Open ${BOLD}http://localhost:3001${NC} in your browser."
  exit 0
fi

# ── Standard (npm) install ───────────────────────────────────────────

if ! check_node; then
  install_node
fi

# Verify node is now available and meets the requirement
if ! check_node; then
  echo -e "${RED}Error: Node.js 22+ is still not available after installation attempt.${NC}"
  echo "Please install Node.js 22+ manually from https://nodejs.org and re-run this script."
  exit 1
fi

echo "Node.js $(node -v) detected."

echo "Installing chvor globally via npm..."
npm install -g chvor

echo ""
echo -e "${GREEN}${BOLD}chvor installed successfully!${NC}"
echo "Running onboarding..."
chvor onboard
