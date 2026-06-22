#!/usr/bin/env bash
#
# deploy.sh - Build and (re)deploy MongoExplorer as a Docker container.
#
# Usage:
#   ./deploy.sh            Build the image and (re)start the container (default)
#   ./deploy.sh build      Build the image only
#   ./deploy.sh up         Start/replace the container using the current image
#   ./deploy.sh down       Stop and remove the container
#   ./deploy.sh restart    Recreate the container from the current image
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
  info "Starting container ${CONTAINER_NAME} ..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart "${RESTART_POLICY}" \
    -p "${BIND_ADDRESS}:${HOST_PORT}:${APP_PORT}" \
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
  require_docker
  case "${cmd}" in
    deploy)      build_image; run_container ;;
    build)       build_image ;;
    up|run)      run_container ;;
    restart)     run_container ;;
    down|stop)   stop_container ;;
    logs)        show_logs ;;
    status|ps)   show_status ;;
    *)
      error "Unknown command: ${cmd}"
      printf 'Usage: %s [deploy|build|up|down|restart|logs|status]\n' "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
