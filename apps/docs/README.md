# Attune docs

The documentation site for the Attune packages, built with
[Nextra](https://nextra.site) (its docs theme) on Next.js.

## Run it

1. `pnpm install` at the repo root.
2. `pnpm dev:docs` at the root (or `pnpm dev` here) starts it on
   http://localhost:5175.

`pnpm build` here builds the site as static files into `out/` (a Next.js
static export, with every page as a folder with an `index.html`) and then
the search index (Pagefind, into `out/_pagefind`). Search works only on a
build, not in `pnpm dev`. To look at a build, serve `out/` with any static
file server, for example `npx serve out`.

## Deploy

`pnpm deploy:docs` at the root (or `pnpm deploy:aws` here) publishes the
site to https://attuneui.dev with `deploy/deploy.sh`, on the same AWS
account (profile `junction`) as the demo:

1. The certificate for attuneui.dev and www (`deploy/cert.yaml`), in
   us-east-1, validated through the domain's Route 53 zone.
2. The site (`deploy/template.yaml`), in us-west-1: a private S3 bucket
   behind CloudFront, and the DNS records. A CloudFront Function sends www
   to attuneui.dev and maps a page path to its `index.html`. A missing page
   shows the site's own not-found page.
3. The files, then a CloudFront invalidation. Hashed assets in
   `_next/static` are cached for a year; everything else is checked on
   each request.

It is safe to run again: each step changes only what changed. The site is
public, so there are no secrets. `deploy/destroy.sh` takes it down (it asks
first).

## For AI assistants

`public/llms.txt` follows the [llms.txt](https://llmstxt.org) format: a
short summary of how to install and set up the packages, and links to the
pages. `public/llms-full.txt` is the whole setup guide in one plain-text
file, with code that compiles. The site serves them at `/llms.txt` and
`/llms-full.txt`. Keep them in step with the packages and with
`content/getting-started.mdx`.

## Write a page

Pages are MDX files in `content/`. A folder is a sidebar section, and its
`_meta.ts` sets the order and the titles. The site's frame (navbar, footer,
links to the repository) is `app/layout.tsx`.

Write from the code: every API name, option, and number on a page should
match the packages. The running example is the playground
(`apps/playground`), so a reader can open the real code.

## Two version notes

- The docs use TypeScript 6, not the repository's TypeScript 7: Nextra's
  code highlighter (twoslash) needs TypeScript 5 or 6.
- The root `package.json` pins `zod` 4.1.12 for Nextra (`pnpm.overrides`).
  `nextra-theme-docs` 4.6.1 was built against it; with zod 4.6 its layout
  check rejects every page.
