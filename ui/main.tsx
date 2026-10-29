import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import "agentic-design/styles.css";
import "./app.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
