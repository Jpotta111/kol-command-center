import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import "./index.css";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (
  !PUBLISHABLE_KEY ||
  PUBLISHABLE_KEY === "placeholder" ||
  !PUBLISHABLE_KEY.startsWith("pk_")
) {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f172a",
          color: "#f8fafc",
          fontFamily: "sans-serif",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <h1>KOL Command Center</h1>
        <p>
          Set VITE_CLERK_PUBLISHABLE_KEY in .env.local and restart the dev
          server.
        </p>
      </div>
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
        <App />
      </ClerkProvider>
    </React.StrictMode>
  );
}
