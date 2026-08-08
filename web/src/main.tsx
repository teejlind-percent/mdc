import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyStoredTheme, startSystemThemeWatcher } from "./theme.js";
import { startPercentUi } from "./percent-ui.js";
// Percent brand faces. Neuzeit Grotesk — the canonical display family — is a
// licensed commercial face and is deliberately absent: this repo is public.
// Hanken Grotesk and Source Sans 3 are OFL, so they self-host safely here.
import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/source-sans-3";
import "highlight.js/styles/github.css";
import "./styles/hljs-dark.css";
import "./styles/tokens.css";
import "./styles/layout.css";
import "./styles/percent-ui.css";
import "./styles/chrome.css";
import "./styles/doc.css";
import "./styles/frontmatter.css";
import "./styles/code.css";
import "./styles/mermaid.css";
import "./styles/images.css";
import "./styles/wikilinks.css";
import "./styles/sidebar.css";
import "./styles/comments.css";
import "./styles/handoff.css";
import "./styles/dashboard.css";
import "./styles/settings.css";

applyStoredTheme();
startSystemThemeWatcher();

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Percent fork: resizable comment margin + whole-document comment composer.
// Works on the rendered DOM and waits for the layout to mount, so it is safe to
// start before React has painted.
startPercentUi();
