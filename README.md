# claw

Tools to provide my coding agents fine-grained access to my repositories.

## Requirements

- [Deno](https://deno.com/) 2.x

## Getting started

```sh
# Run the CLI
deno task start dtinth/claw:read

# Watch mode
deno task dev
```

## Access scopes

Access is expressed as scopes of the form `owner/repo:permission`, where
permission is one of `read`, `write`, or `admin`. For example:

```sh
deno task start dtinth/claw:read acme/widgets:write
```

Parsing lives in [`src/scope.ts`](src/scope.ts) and is the seed the rest of the
project grows from.

## Development

```sh
deno task test    # run the test suite
deno task check   # type-check
deno task ci      # fmt --check + lint + check + test (what CI runs)
```

Formatting and linting are configured in [`deno.json`](deno.json).
