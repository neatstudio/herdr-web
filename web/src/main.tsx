import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}
// The HTML paints a boot shell so a slow link is not a blank page; the real UI
// replaces it as soon as React has mounted.
document.getElementById("boot")?.remove();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
