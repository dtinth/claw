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

USER deno

# claw is stateless — no volume needed. The platform typically injects PORT;
# claw defaults to 8000 otherwise.
EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "src/main.ts"]
