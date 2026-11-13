# Image every agent and child container runs.
#
# It ships the built runtime at /root/automaton, so a child starts from the
# exact code its parent runs instead of cloning and building at spawn time.
# Build with: automaton-host build-image
FROM node:22-bookworm-slim

# git/curl: used by the agent's own tools. procps: pgrep, which the host uses
# to see whether the runtime is alive. python3/make/g++: only needed if
# better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates procps python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.28.1

WORKDIR /root/automaton
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# A local repository with NO remote. The runtime's upstream tools pull from
# `origin`; with the original remote they would replace this fork with
# Conway's code. Leaving origin unset makes those tools report "no upstream"
# and keeps code changes under the creator's control (rebuild the image).
RUN git init -q -b main \
 && git -c user.name=automaton-host -c user.email=host@localhost add -A \
 && git -c user.name=automaton-host -c user.email=host@localhost commit -q -m "runtime image"

WORKDIR /root
# The host starts the runtime with `docker exec`; PID 1 just keeps the
# container alive so a runtime restart (after self-modification) does not
# take the container down with it.
CMD ["sleep", "infinity"]
