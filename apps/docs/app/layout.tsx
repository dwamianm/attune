/** The site frame: the docs theme's navbar, sidebar from content/, search, and footer. */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";

export const metadata: Metadata = {
  title: { default: "Attune", template: "%s | Attune" },
  description: "Attune is an adaptive UI library: a canvas of panels that rearranges itself around what the user is doing.",
};

const REPO = "https://github.com/dwamianm/attune";

const navbar = <Navbar logo={<b>Attune</b>} projectLink={REPO} />;
const footer = <Footer>MIT {new Date().getFullYear()} © AttuneUI.</Footer>;

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout navbar={navbar} pageMap={await getPageMap()} docsRepositoryBase={`${REPO}/tree/main/apps/docs`} footer={footer} sidebar={{ defaultMenuCollapseLevel: 1 }}>
          {children}
        </Layout>
      </body>
    </html>
  );
}
