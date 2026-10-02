# Attune docs

The documentation site for the Attune packages, built with
[Nextra](https://nextra.site) (its docs theme) on Next.js.

## Run it

1. `pnpm install` at the repo root.
2. `pnpm dev:docs` at the root (or `pnpm dev` here) starts it on
   http://localhost:5175.

`pnpm build` here builds the static pages and then the search index
(Pagefind, into `public/_pagefind`, which git ignores). `pnpm start` serves
the build. Search works only on a build, not in `pnpm dev`.

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
