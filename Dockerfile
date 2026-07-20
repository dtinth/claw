# claw — GitHub App token broker + comment drafting server.
# Pinned to the current stable Deno; bump deliberately.
FROM denoland/deno:2.9.3

WORKDIR /app

# Cache dependencies first so they are only refetched when they change.
COPY deno.json deno.lock ./
RUN deno install

# Copy the source and compile it into the module cache.
COPY . .
RUN deno cache src/main.ts

# Deno KV writes to this SQLite path. Mount a volume here to persist drafts and
# sessions across redeploys; otherwise they are ephemeral (you log in again).
ENV DENO_KV_PATH=/data/kv.sqlite
RUN mkdir -p /data && chown -R deno:deno /data /app

USER deno

# The platform typically injects PORT; claw defaults to 8000 otherwise.
EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "src/main.ts"]
