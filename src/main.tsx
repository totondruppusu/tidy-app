import React from "react";
import "@fontsource/pacifico/400.css";
import "@fontsource/material-symbols-rounded/400.css";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./styles/app.css";

if (isTauri() && !/android/i.test(navigator.userAgent)) {
  void getCurrentWindow().setSizeConstraints({ minWidth: 350 }).catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
