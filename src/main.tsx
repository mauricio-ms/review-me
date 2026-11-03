import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTextScale } from "./lib/text-scale";
import "./styles.css";

initTextScale();

// WebKit's own menu (Back, Reload, Inspect Element) has nothing for a reviewer.
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
