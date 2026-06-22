#!/usr/bin/env bash
#
# deploy.sh - Build and (re)deploy MongoExplorer as a Docker container.
#
# Usage:
#   ./deploy.sh            Pull latest code, build image, recreate container (default)
#   ./deploy.sh build      Build the image only
#   ./deploy.sh up         Start/replace the container using the current image
#   ./deploy.sh down       Stop and remove the container
#   ./deploy.sh restart    Recreate the container from the current image
#   ./deploy.sh pull       Pull latest code from git only
#   ./deploy.sh logs       Follow container logs
#   ./deploy.sh status     Show container status
#
# Configuration (override via environment variables):
#   IMAGE_NAME      Docker image name             (default: mongo-explorer)
#   IMAGE_TAG       Docker image tag              (default: latest)
#   CONTAINER_NAME  Running container name        (default: mongo-explorer)
#   HOST_PORT       Published host port           (default: 3000)
#   APP_PORT        In-container app port         (default: 3000)
#   BIND_ADDRESS    Host interface to publish on  (default: 127.0.0.1)
#   RESTART_POLICY  Docker restart policy         (default: unless-stopped)
#   ENV_FILE        Env file passed to container  (default: .env)
#   GIT_PULL        Pull latest code on deploy    (default: true)
#   GIT_REMOTE      Git remote to pull from       (default: origin)
#   GIT_BRANCH      Git branch to pull            (default: current branch)
#
# SECURITY: The port is published only on 127.0.0.1 by default because this
# service brokers raw MongoDB credentials and must not be exposed on the
# network. Set BIND_ADDRESS=0.0.0.0 only behind a trusted reverse proxy + TLS.

set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-mongo-explorer}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
CONTAINER_NAME="${CONTAINER_NAME:-mongo-explorer}"
HOST_PORT="${HOST_PORT:-3000}"
APP_PORT="${APP_PORT:-3000}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
RESTART_POLICY="${RESTART_POLICY:-unless-stopped}"
ENV_FILE="${ENV_FILE:-.env}"
GIT_PULL="${GIT_PULL:-true}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; }

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    error "Docker is not installed or not on PATH."
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    error "Docker daemon is not running or not accessible."
    exit 1
  fi
}

# Pull the latest source from git before building so the image reflects the
# newest code. Uses --ff-only to refuse merges: a deploy host should track the
# remote cleanly. Set GIT_PULL=false to deploy the current working tree as-is.
pull_code() {
  if [[ "${GIT_PULL}" != "true" ]]; then
    info "Skipping git pull (GIT_PULL=${GIT_PULL})."
    return
  fi
  if ! command -v git >/dev/null 2>&1; then
    error "Git is not installed or not on PATH. Set GIT_PULL=false to skip."
    exit 1
  fi
  if ! git -C "${SCRIPT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    error "${SCRIPT_DIR} is not a git repository. Set GIT_PULL=false to skip."
    exit 1
  fi
  local branch="${GIT_BRANCH}"
  if [[ -z "${branch}" ]]; then
    branch="$(git -C "${SCRIPT_DIR}" rev-parse --abbrev-ref HEAD)"
  fi
  info "Pulling latest code from ${GIT_REMOTE}/${branch} ..."
  git -C "${SCRIPT_DIR}" pull --ff-only "${GIT_REMOTE}" "${branch}"
  info "Code updated."
}

build_image() {
  info "Building image ${IMAGE} ..."
  docker build -t "${IMAGE}" "${SCRIPT_DIR}"
  info "Build complete."
}

remove_existing() {
  if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    info "Removing existing container ${CONTAINER_NAME} ..."
    docker rm -f "${CONTAINER_NAME}" >/dev/null
  fi
}

run_container() {
  remove_existing

  # The app fails closed without APP_ACCESS_KEY, so an env file is required.
  local env_args=()
  if [[ -f "${SCRIPT_DIR}/${ENV_FILE}" ]]; then
    info "Loading environment from ${ENV_FILE}"
    env_args+=(--env-file "${SCRIPT_DIR}/${ENV_FILE}")
  else
    error "Env file '${ENV_FILE}' not found next to deploy.sh."
    error "The app requires APP_ACCESS_KEY. Create it with: cp .env.example .env"
    exit 1
  fi

  info "Starting container ${CONTAINER_NAME} ..."
  # PORT/HOST are set after --env-file so they win: the container must listen on
  # 0.0.0.0 regardless of what the env file says.
  docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart "${RESTART_POLICY}" \
    -p "${BIND_ADDRESS}:${HOST_PORT}:${APP_PORT}" \
    "${env_args[@]}" \
    -e "PORT=${APP_PORT}" \
    -e "HOST=0.0.0.0" \
    "${IMAGE}" >/dev/null
  info "Container started."
  info "MongoExplorer is available at http://${BIND_ADDRESS}:${HOST_PORT}"
}

stop_container() {
  remove_existing
  info "Container ${CONTAINER_NAME} stopped and removed."
}

show_logs()   { docker logs -f "${CONTAINER_NAME}"; }

show_status() {
  docker ps -a --filter "name=^/${CONTAINER_NAME}$" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

main() {
  local cmd="${1:-deploy}"
  case "${cmd}" in
    deploy)      pull_code; require_docker; build_image; run_container ;;
    build)       require_docker; build_image ;;
    up|run)      require_docker; run_container ;;
    restart)     require_docker; run_container ;;
    down|stop)   require_docker; stop_container ;;
    pull)        pull_code ;;
    logs)        require_docker; show_logs ;;
    status|ps)   require_docker; show_status ;;
    *)
      error "Unknown command: ${cmd}"
      printf 'Usage: %s [deploy|build|up|down|restart|pull|logs|status]\n' "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
