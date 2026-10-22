// One imported object in the grid: its thumbnail, title, "GLB · 12,480 triangles", and the source application as a
// text chip with a neutral glyph (no third-party logos, APPLE_STYLE_SPEC §3.5).

import { Box } from "lucide-react";
import { useAssetUrl } from "../../app/shell/queries";
import type { ImportedObject } from "../../core/types";
import { Badge, Icon, MediaCard } from "../../ui";
import { cardSubtitle, sourceBadge, sourceDescription } from "./model";

export interface ImportCardProps {
  object: ImportedObject;
  onFavoriteChange: (favorite: boolean) => void;
  onMore: (anchor: HTMLElement) => void;
}

export function ImportCard({ object, onFavoriteChange, onMore }: ImportCardProps) {
  const thumbnail = useAssetUrl(object.thumbnailAssetId);
  return (
    <MediaCard
      id={object.id}
      title={object.title}
      subtitle={cardSubtitle(object)}
      thumbnail={thumbnail}
      placeholder={
        <span className="px-imports-card__placeholder">
          <Icon icon={Box} size={40} />
        </span>
      }
      badges={
        <Badge tone="hud" icon={Box}>
          {sourceBadge(object.sourceApp)}
        </Badge>
      }
      description={sourceDescription(object.sourceApp)}
      favorite={object.favorite}
      onFavoriteChange={onFavoriteChange}
      onMore={onMore}
    />
  );
}
