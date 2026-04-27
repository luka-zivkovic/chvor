import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * `fullscreen` — global app boundary, occupies the whole viewport.
   * `inline` — panel/section boundary, fills its container.
   */
  variant?: "fullscreen" | "inline";
  /** Human label used in the inline header (e.g. "Skills panel"). */
  scope?: string;
  /** Reset key — when it changes, the boundary clears its error state. */
  resetKey?: string | number;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

const ISSUE_URL = "https://github.com/anthropics/chvor/issues/new";

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const scope = this.props.scope ?? this.props.variant ?? "app";
    console.error(`[ErrorBoundary:${scope}] Uncaught render error:`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // When the parent rotates resetKey (e.g. switching to a different panel),
    // clear the error so we can attempt a fresh render.
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { variant = "fullscreen", scope } = this.props;
    const errorMessage = this.state.error?.message ?? "Unknown error";

    if (variant === "inline") {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-foreground">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 className="text-sm font-semibold">
            {scope ? `${scope} crashed` : "This view crashed"}
          </h2>
          <pre className="max-h-32 max-w-md overflow-auto rounded-md border border-border bg-card/50 p-2 text-xs text-muted-foreground">
            {errorMessage}
          </pre>
          <button
            onClick={this.reset}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      );
    }

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          An unexpected error occurred. Try again, refresh the page, or report this if it keeps happening.
        </p>
        {this.state.error && (
          <pre className="mt-2 max-w-lg overflow-auto rounded-lg border border-border bg-card/50 p-3 text-xs text-muted-foreground">
            {errorMessage}
          </pre>
        )}
        <div className="mt-2 flex gap-2">
          <button
            onClick={this.reset}
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Refresh
          </button>
          <a
            href={`${ISSUE_URL}?title=${encodeURIComponent(`Render error: ${errorMessage.slice(0, 80)}`)}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Report issue
          </a>
        </div>
      </div>
    );
  }
}
