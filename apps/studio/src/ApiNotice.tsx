import { useState } from "react";
import { useApiOnline, OFFLINE_MESSAGE } from "./api";
import "./apiNotice.css";

/** One dismissible line under the header when the API is absent (the public copy): what runs here, what needs the
 *  local studio. Fixed, so it sits the same over each workspace's own layout. */
export function ApiNotice() {
  const online = useApiOnline();
  const [closed, setClosed] = useState(false);
  if (online !== false || closed) return null;
  return <div className="api-notice" role="status">
    <p>{OFFLINE_MESSAGE}</p>
    <button type="button" onClick={() => setClosed(true)} aria-label="Dismiss this notice">×</button>
  </div>;
}
