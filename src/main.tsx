import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTextScale } from "./lib/text-scale";
import "./styles.css";

initTextScale();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
