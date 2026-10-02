/** A path with no page: the docs theme's "not found" page, with a link to report the broken link. */
import { NotFoundPage } from "nextra-theme-docs";

export default function NotFound() {
  return (
    <NotFoundPage content="Report the broken link" labels="broken-link">
      <h1>This page does not exist</h1>
    </NotFoundPage>
  );
}
