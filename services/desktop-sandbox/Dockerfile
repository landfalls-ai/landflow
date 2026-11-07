# syntax=docker/dockerfile:1
#
# The desktop sandbox (docs/specs/18-desktop-agent-node.md, section 2): Xvfb, a bare Openbox, xdotool, scrot and the
# allow-listed apps (Firefox ESR and Mousepad). One container is one session; the plugin (plugins/desktop) starts it with
# `docker run` and talks to it through `docker exec ... sandbox.py ctl`, so the container needs no network port.
# No terminal, no file manager and no shell for the agent is installed: the app allow-list would mean nothing otherwise.
#
#   COMPOSE_BAKE=false docker --context orbstack buildx build --builder orbstack --load \
#     -f services/desktop-sandbox/Dockerfile -t landflow/desktop-sandbox:dev services/desktop-sandbox
#
# Run it the way plugins/desktop does: --read-only, --cap-drop ALL, no-new-privileges, tmpfs /tmp /home/sandbox /work,
# --network none (or an internal network plus the allow-list proxy), memory, cpu and pids limits, no mounts.
FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11-utils xdotool scrot imagemagick openbox mousepad firefox-esr python3 \
      fonts-dejavu-core fonts-liberation dbus-x11 adwaita-icon-theme \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --home-dir /home/sandbox --shell /usr/sbin/nologin sandbox
COPY sandbox.py proxy.py openbox-rc.xml /opt/sandbox/
ENV DISPLAY=:99 HOME=/home/sandbox XDG_RUNTIME_DIR=/tmp/xdg MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DBUS_REMOTE=0 NO_AT_BRIDGE=1
USER sandbox
WORKDIR /home/sandbox
HEALTHCHECK --interval=3s --timeout=2s --start-period=2s --retries=20 CMD test -f /tmp/ready
CMD ["python3", "/opt/sandbox/sandbox.py", "serve"]
