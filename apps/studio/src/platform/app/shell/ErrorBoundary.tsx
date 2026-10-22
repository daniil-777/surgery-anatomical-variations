// A page that throws while rendering (or whose code cannot be downloaded) shows a calm message in its place instead
// of a blank window; the rest of the shell keeps working. Navigating elsewhere resets it.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Button, EmptyState } from "../../ui";
import { errorMessage } from "../messages";

interface PageErrorBoundaryProps {
  /** A new key (the route) clears the error. */
  resetKey: string;
  /** "stage" for full-window routes (dark). */
  variant?: "page" | "stage" | undefined;
  children: ReactNode;
}

interface PageErrorBoundaryState {
  failed: boolean;
  error: unknown;
  key: string;
}

function isChunkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically/i.test(message);
}

export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  override state: PageErrorBoundaryState = { failed: false, error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<PageErrorBoundaryState> {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: PageErrorBoundaryProps, state: PageErrorBoundaryState): Partial<PageErrorBoundaryState> | null {
    return props.resetKey !== state.key ? { failed: false, error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // React reports the error itself; the boundary only replaces the broken page
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const chunk = isChunkFailure(this.state.error);
    return (
      <div className={this.props.variant === "stage" ? "px-shell-error px-shell-error--stage" : "px-shell-error"}>
        <EmptyState
          icon={CircleAlert}
          title={chunk ? "Couldn’t Load This Page" : "This Page Stopped Working"}
          description={
            chunk
              ? "Part of VISCERA couldn’t be downloaded. Check your connection, then reload the page."
              : errorMessage(this.state.error)
          }
          action={
            <>
              <Button onClick={() => this.setState({ failed: false, error: null })}>Try Again</Button>
              <Button variant="borderedProminent" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </>
          }
        />
      </div>
    );
  }
}
