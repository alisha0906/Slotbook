import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Top-level error boundary. Without this, a render-time throw under
 * React.StrictMode unmounts the whole tree and leaves a blank page with the
 * real error only in the console. Showing it on-screen makes failures obvious.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("Render error:", error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="container">
          <div className="card">
            <div className="banner error">
              <strong>Something broke on this page.</strong>
              <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
                {this.state.error.message}
                {"\n"}
                {this.state.error.stack}
              </pre>
            </div>
            <button onClick={() => this.setState({ error: null })}>Dismiss</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
