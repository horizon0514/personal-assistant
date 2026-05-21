import React from "react";
import ReactDOM from "react-dom/client";
import { SettingsApp } from "./features/settings/SettingsApp";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>
);
