// Content-column building blocks for shell pages: the padded page, titled sections (Title 2, "Show All ›" on the
// trailing side), and thumbnails behind signed URLs with the lab-tint placeholder of APPLE_STYLE_SPEC §3.2.

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import type { LabDefinition } from "../../core/labs/registry";
import type { Uuid } from "../../core/types";
import { Icon, cssVars, cx } from "../../ui";
import { labIcon, labTint } from "./labIcons";
import { useAssetUrl } from "./queries";
import "./styles/shell.css";

export interface PageProps {
  /** "narrow" centres a 720 px column (settings); "wide" uses the whole content width. */
  width?: "wide" | "narrow" | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function Page({ width = "wide", className, children }: PageProps) {
  return <div className={cx("px-page", width === "narrow" && "px-page--narrow", className)}>{children}</div>;
}

export interface PageSectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** A plain accent link or a small control on the trailing side of the title. */
  trailing?: ReactNode;
  id?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function PageSection({ title, description, trailing, id, className, children }: PageSectionProps) {
  const headingId = useId();
  return (
    <section id={id} className={cx("px-page-section", className)} aria-labelledby={headingId}>
      <div className="px-page-section__header">
        <div className="px-page-section__titles">
          <h2 id={headingId} className="px-page-section__title">
            {title}
          </h2>
          {description ? <p className="px-page-section__description">{description}</p> : null}
        </div>
        {trailing ? <div className="px-page-section__trailing">{trailing}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A lab's glyph on its tint (thumbnails that have no image yet). */
export function LabPlaceholder({ lab, size = 28 }: { lab: LabDefinition | null; size?: number }) {
  const style: CSSProperties | undefined = lab ? cssVars({ "--_tint": labTint(lab) }) : undefined;
  return (
    <span className="px-thumb-placeholder" style={style} aria-hidden="true">
      {lab ? <Icon icon={labIcon(lab.icon)} size={size} /> : null}
    </span>
  );
}

export interface AssetThumbnailProps {
  assetId: Uuid | null | undefined;
  /** Shown while there is no image (no asset, still loading, or it failed). */
  placeholder: ReactNode;
}

/** The image of a card's .px-card__thumb: fades in once loaded, falls back to the placeholder. */
export function AssetThumbnail({ assetId, placeholder }: AssetThumbnailProps) {
  const url = useAssetUrl(assetId);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [url]);
  return (
    <>
      {!loaded || failed || !url ? placeholder : null}
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          data-loaded={loaded || undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </>
  );
}
