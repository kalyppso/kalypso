import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { StoreProvider } from "./store";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </React.StrictMode>,
);
