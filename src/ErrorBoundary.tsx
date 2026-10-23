import { Component, type ErrorInfo, type ReactNode } from "react";
import { forgetFailedPages } from "./lazy.ts";

/** Catches a page that throws (or a chunk that failed to download) so the rest
 *  of the app, and the unlock, survive. It sits below the header and above the
 *  pages only; the decrypted catalogue lives outside React, so "try again"
 *  loses nothing and even a full reload resumes from the session key. */
export default class ErrorBoundary extends Component<
  { children: ReactNode; /** Change this and the boundary clears itself (a new route). */ resetKey: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.retry();
  }

  retry = () => { forgetFailedPages(); this.setState({ error: null }); };

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("page crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <div className="panel mdc-oops" role="alert">
          <h2>Something went sideways</h2>
          <p>This page hit a snag. You are still signed in; nothing was lost.</p>
          <div className="row">
            <button className="btn" onClick={this.retry}>Try again</button>
            <button className="btn ghost" onClick={() => window.location.reload()}>Reload the page</button>
          </div>
        </div>
      </div>
    );
  }
}
