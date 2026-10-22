// #/imports[?source=…] and #/imports/<id>: the Imports space for objects from Unity, Blender and other tools
// (DESIGN.md G4, APPLE_STYLE_SPEC §3.5). The grid with its drop zone and the 3D view of one import live in
// components/imports.
import type { SourceApp } from "../../core/types";
import { ImportDetail } from "../../components/imports/ImportDetail";
import { ImportsBrowser } from "../../components/imports/ImportsBrowser";

export interface ImportsPageProps {
  source?: SourceApp | undefined;
  objectId?: string | undefined;
}

export default function ImportsPage({ source, objectId }: ImportsPageProps) {
  return objectId ? <ImportDetail objectId={objectId} source={source} /> : <ImportsBrowser source={source} />;
}
