// The Attune docs: Nextra's docs theme on Next.js. Pages are MDX files in content/.
import nextra from "nextra";

const withNextra = nextra({
  // Twoslash and LaTeX stay off: the pages show plain TypeScript.
  defaultShowCopyCode: true,
});

export default withNextra({
  reactStrictMode: true,
});
