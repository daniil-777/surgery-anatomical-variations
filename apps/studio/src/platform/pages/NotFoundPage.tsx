// An address the shell does not know (#/nowhere, a malformed id): say so and offer the way Home.

import { FileQuestion } from "lucide-react";
import { Button, EmptyState } from "../ui";
import { navigate } from "../app/router";
import { PageToolbar } from "../app/shell/PageToolbar";
import "../app/shell/styles/shell.css";

export default function NotFoundPage() {
  return (
    <>
      <PageToolbar title="Page Not Found" />
      <div className="px-shell-error">
        <EmptyState
          icon={FileQuestion}
          title="Page Not Found"
          description="There’s nothing at this address. The link may be incomplete, or the item may have moved."
          action={
            <Button variant="borderedProminent" onClick={() => navigate({ name: "home" })}>
              Go to Home
            </Button>
          }
        />
      </div>
    </>
  );
}
