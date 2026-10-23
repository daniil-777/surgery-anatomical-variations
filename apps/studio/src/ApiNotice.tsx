import { useState } from "react";
import { useApiOnline, OFFLINE_MESSAGE } from "./api";
import "./apiNotice.css";

/** In-flow header notice: capability details must not cover scene or panel controls. */
export function ApiNotice() {
  const online = useApiOnline();
  const [closed, setClosed] = useState(false);
  if (online !== false || closed) return null;
  return <div className="api-notice" role="status">
    <div><p>Browser mode · core tools run locally. Some exports and services need the VISCERA API.</p><details><summary>Available features</summary><p>{OFFLINE_MESSAGE}</p></details></div>
    <button type="button" onClick={() => setClosed(true)} aria-label="Dismiss this notice">×</button>
  </div>;
}
