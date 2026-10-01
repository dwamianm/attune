/**
 * Browser entry point: mounts the single-screen app and loads the global
 * styles and design tokens. The first-visit welcome screen mounts beside the
 * app (not inside App.tsx) so the app shell stays independent of it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Welcome } from "./ui/Welcome.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
    <Welcome />
  </StrictMode>,
);
