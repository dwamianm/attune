// The Attune docs: Nextra's docs theme on Next.js. Pages are MDX files in content/.
// The build is a static export (out/), which deploy/deploy.sh serves from S3 through CloudFront.
import nextra from "nextra";

const withNextra = nextra({
  defaultShowCopyCode: true,
});

export default withNextra({
  reactStrictMode: true,
  output: "export",
  // Every page is a folder with an index.html, so plain static hosting finds it.
  trailingSlash: true,
  images: { unoptimized: true },
});
