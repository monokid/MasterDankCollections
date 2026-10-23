import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/figtree/wght.css";
import "./styles.css";   // base theme first; App then pulls core.css / pages.css, which win ties
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
