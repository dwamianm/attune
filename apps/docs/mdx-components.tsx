import { useMDXComponents as getThemeComponents } from "nextra-theme-docs";
import type { MDXComponents } from "nextra/mdx-components";

const themeComponents = getThemeComponents();

/** The docs theme's components for every MDX page, and any given here on top. */
export function useMDXComponents(components?: MDXComponents): MDXComponents {
  return { ...themeComponents, ...components };
}
