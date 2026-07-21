import * as Sentry from "@sentry/browser";
import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

// A render error anywhere in the tree would otherwise unmount the whole
// karaoke display and leave a blank screen with no way to recover. Catch it,
// report it, and show a minimal recovery UI instead so a host can get the
// display back without restarting the app.
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Renderer error boundary caught an error:", error, info);
    Sentry.captureException(error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: "1rem",
            fontFamily: "sans-serif",
            textAlign: "center",
            padding: "2rem",
          }}
        >
          <h1>Something went wrong</h1>
          <p>The karaoke display hit an unexpected error.</p>
          <button
            style={{ fontSize: "1.25rem", padding: "0.5rem 1.5rem" }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
