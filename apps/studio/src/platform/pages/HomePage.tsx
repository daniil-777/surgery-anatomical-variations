// Home (APPLE_STYLE_SPEC §3.2). Guests: what VISCERA is, the labs (they open without an account) and a way to sign in;
// nothing here makes a request while signed out. Signed in: a greeting, "Start a New Project" per lab, recent projects
// (newest edits first, at most 8), what was added to the Library last, and the storage meter.

import { useMemo, type ReactNode } from "react";
import { Cuboid, FolderClosed, History, Images, Import, Plus, type LucideIcon } from "lucide-react";
import { getLab, listLabs, type LabDefinition } from "../core/labs/registry";
import type { LibraryItem, Project } from "../core/types";
import {
  AppMark,
  Button,
  Icon,
  MenuButton,
  MenuItem,
  MenuSection,
  Skeleton,
  StorageMeter,
  cssVars,
  formatBytes,
  useDeferredLoading,
} from "../ui";
import { usePlatform, useSession } from "../app/context";
import { errorMessage } from "../app/messages";
import { formatRoute, navigate } from "../app/router";
import { labIcon, labTint } from "../app/shell/labIcons";
import { AssetThumbnail, LabPlaceholder, Page, PageSection } from "../app/shell/Page";
import { PageToolbar } from "../app/shell/PageToolbar";
import { accountDisplayName, useFreshQuery, useProfile, useUsage } from "../app/shell/queries";
import { libraryKindName } from "../app/shell/routeMeta";
import { formatEdited, greeting } from "../app/shell/time";
import "../app/shell/styles/home.css";

export default function HomePage() {
  const session = useSession();
  return session ? <SignedInHome userId={session.user.id} email={session.user.email} /> : <GuestHome />;
}

// Guests --------------------------------------------------------------------------------------------------------------

function GuestHome() {
  const labs = useMemo(() => listLabs(), []);
  return (
    <>
      <PageToolbar
        title="Home"
        trailing={
          <>
            <Button size="toolbar" variant="glass" onClick={() => navigate({ name: "signin" })}>
              Sign In
            </Button>
            <Button size="toolbar" variant="borderedProminent" onClick={() => navigate({ name: "signup" })}>
              Create Account
            </Button>
          </>
        }
      />
      <Page className="px-home">
        <section className="px-home-hero" aria-labelledby="px-home-hero-title">
          <AppMark size={56} />
          <h2 id="px-home-hero-title" className="px-home-hero__title">
            Design anatomical variations in your browser.
          </h2>
          <p className="px-home-hero__lede">
            Generate and sculpt organ shapes, give them surfaces and explore the whole-body scene. Every lab opens without
            an account; create one to save your work as projects with version history and keep a personal library.
          </p>
          <div className="px-home-hero__actions">
            <Button size="large" variant="borderedProminent" onClick={() => navigate({ name: "signup" })}>
              Create Account
            </Button>
            <Button size="large" onClick={() => navigate({ name: "signin" })}>
              Sign In
            </Button>
          </div>
        </section>

        <PageSection title="Open a Lab" description="Labs open as a guest. Sign in to save what you make.">
          <LabTiles labs={labs} intent="open" />
        </PageSection>

        <PageSection title="With an Account">
          <ul className="px-home-features" role="list">
            <Feature icon={History} title="Projects with history">
              Changes save as you work. Go back to any earlier version, or keep one by name.
            </Feature>
            <Feature icon={Images} title="A personal library">
              Keep finished shapes with their surfaces, materials and recorded physics runs.
            </Feature>
            <Feature icon={Import} title="Your imports">
              Bring in models from Unity, Blender and other tools and view them in 3D.
            </Feature>
          </ul>
        </PageSection>
      </Page>
    </>
  );
}

function Feature({ icon, title, children }: { icon: LucideIcon; title: string; children: string }) {
  return (
    <li className="px-home-feature">
      <span className="px-home-feature__icon">
        <Icon icon={icon} size={18} />
      </span>
      <span className="px-home-feature__text">
        <span className="px-home-feature__title">{title}</span>
        <span className="px-home-feature__body">{children}</span>
      </span>
    </li>
  );
}

// Labs ----------------------------------------------------------------------------------------------------------------

function LabTiles({ labs, intent }: { labs: readonly LabDefinition[]; intent: "open" | "new" }) {
  return (
    <ul className="px-lab-tiles" role="list">
      {labs.map((lab) => {
        const action = intent === "new" && lab.capabilities.projects ? "New Project" : "Open";
        return (
          <li key={lab.id}>
            <a className="px-lab-tile" href={formatRoute({ name: "lab", labId: lab.id })} style={cssVars({ "--_tint": labTint(lab) })}>
              <span className="px-lab-tile__glyph" aria-hidden="true">
                <Icon icon={labIcon(lab.icon)} size={16} />
              </span>
              <span className="px-lab-tile__name">{lab.title}</span>
              <span className="px-lab-tile__description">{lab.description}</span>
              <span className="px-lab-tile__action">{action}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

// Signed in -----------------------------------------------------------------------------------------------------------

function SignedInHome({ userId, email }: { userId: string; email: string | null }) {
  const { backend } = usePlatform();
  const labs = useMemo(() => listLabs(), []);
  const projectLabs = labs.filter((lab) => lab.capabilities.projects);
  const profile = useProfile().data;
  const usage = useUsage();
  const projects = useFreshQuery(`projects:recent:${userId}`, () => backend.projects.list({ orderBy: "updated", limit: 8 }));
  const library = useFreshQuery(`library:recent:${userId}`, () => backend.library.list({ limit: 8 }));
  const name = profile ? accountDisplayName(profile, email) : null;

  return (
    <>
      <PageToolbar
        title="Home"
        trailing={
          projectLabs.length > 0 ? (
            <MenuButton
              size="toolbar"
              variant="borderedProminent"
              icon={Plus}
              placement="bottom-end"
              menu={
                <MenuSection title="New Project In">
                  {projectLabs.map((lab) => (
                    <MenuItem key={lab.id} icon={labIcon(lab.icon)} onSelect={() => navigate({ name: "lab", labId: lab.id })}>
                      {lab.title}
                    </MenuItem>
                  ))}
                </MenuSection>
              }
            >
              New Project
            </MenuButton>
          ) : null
        }
      />
      <Page className="px-home">
        <header className="px-home-greeting">
          <h2 className="px-home-greeting__title">{greeting(name)}</h2>
          <p className="px-home-greeting__lede">Pick up where you left off, or start something new.</p>
        </header>

        <PageSection title="Start a New Project">
          <LabTiles labs={labs} intent="new" />
        </PageSection>

        <PageSection title="Recent Projects" trailing={<a href={formatRoute({ name: "projects" })}>Show All</a>}>
          <RecentGrid
            loading={projects.loading && projects.data === undefined}
            error={projects.data === undefined ? projects.error : undefined}
            onRetry={() => void projects.refresh()}
            empty={
              <InlineEmpty icon={FolderClosed} title="No Projects Yet">
                Start one above. Your changes save as you work, and earlier versions stay available.
              </InlineEmpty>
            }
            ratio="16:10"
            what="Recent Projects"
          >
            {projects.data?.length ? projects.data.map((project) => <ProjectCard key={project.id} project={project} />) : null}
          </RecentGrid>
        </PageSection>

        <PageSection title="Recently Added to Library" trailing={<a href={formatRoute({ name: "library" })}>Show All</a>}>
          <RecentGrid
            loading={library.loading && library.data === undefined}
            error={library.data === undefined ? library.error : undefined}
            onRetry={() => void library.refresh()}
            empty={
              <InlineEmpty icon={Cuboid} title="No Items Yet">
                Shapes, materials and recordings you add from a lab appear here.
              </InlineEmpty>
            }
            ratio="1:1"
            what="Library"
          >
            {library.data?.length ? library.data.map((item) => <LibraryCard key={item.id} item={item} />) : null}
          </RecentGrid>
        </PageSection>

        <PageSection title="Storage" trailing={<a href={formatRoute({ name: "settings", section: "storage" })}>Manage Storage</a>}>
          <div className="px-home-storage">
            {usage.data ? (
              <>
                <StorageMeter usedBytes={usage.data.usedBytes + usage.data.pendingBytes} quotaBytes={usage.data.storageQuotaBytes} compact />
                <p className="px-home-storage__plan">
                  {usage.data.planTitle} plan · files up to {formatBytes(usage.data.maxFileBytes)} · {usage.data.projectCount} of{" "}
                  {usage.data.maxProjects} projects
                </p>
              </>
            ) : usage.error ? (
              <p className="px-home-storage__plan">{errorMessage(usage.error, "load")}</p>
            ) : (
              <Skeleton height={34} radius={6} />
            )}
          </div>
        </PageSection>
      </Page>
    </>
  );
}

interface RecentGridProps {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  empty: ReactNode;
  ratio: "16:10" | "1:1";
  what: string;
  children: ReactNode;
}

function RecentGrid({ loading, error, onRetry, empty, ratio, what, children }: RecentGridProps) {
  const showSkeleton = useDeferredLoading(loading);
  if (loading) {
    return showSkeleton ? (
      <div className="px-home-grid" data-ratio={ratio} aria-busy="true" aria-label={`Loading ${what}`}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="px-home-skeleton">
            <Skeleton height="auto" radius={10} className="px-home-skeleton__thumb" />
            <Skeleton width="60%" />
            <Skeleton width="40%" />
          </div>
        ))}
      </div>
    ) : (
      <div className="px-home-grid-placeholder" aria-busy="true" />
    );
  }
  if (error !== undefined && error !== null) {
    return (
      <div className="px-home-inline-error" role="alert">
        <p>{errorMessage(error, "load")}</p>
        <Button onClick={onRetry}>Try Again</Button>
      </div>
    );
  }
  if (!children) return <>{empty}</>;
  return (
    <ul className="px-home-grid" data-ratio={ratio} role="list" aria-label={what}>
      {children}
    </ul>
  );
}

function InlineEmpty({ icon, title, children }: { icon: LucideIcon; title: string; children: string }) {
  return (
    <div className="px-home-empty">
      <Icon icon={icon} size={20} className="px-home-empty__icon" />
      <div>
        <p className="px-home-empty__title">{title}</p>
        <p className="px-home-empty__body">{children}</p>
      </div>
    </div>
  );
}

function editedAt(project: Project): string {
  const draft = project.draftSavedAt ? Date.parse(project.draftSavedAt) : 0;
  return draft > Date.parse(project.updatedAt) ? (project.draftSavedAt as string) : project.updatedAt;
}

function ProjectCard({ project }: { project: Project }) {
  const lab = getLab(project.labId);
  return (
    <li className="px-home-grid__item">
      <a className="px-card px-home-card" data-ratio="16:10" href={formatRoute({ name: "project", id: project.id })}>
        <span className="px-card__thumb" style={lab ? cssVars({ "--_tint": labTint(lab) }) : undefined}>
          <AssetThumbnail assetId={project.thumbnailAssetId ?? project.draftThumbnailAssetId} placeholder={<LabPlaceholder lab={lab} />} />
        </span>
        <span className="px-card__text">
          <span className="px-card__title">{project.title}</span>
          <span className="px-card__subtitle">
            {lab?.title ?? "Lab"} · {formatEdited(editedAt(project))}
          </span>
        </span>
      </a>
    </li>
  );
}

function LibraryCard({ item }: { item: LibraryItem }) {
  const lab = item.labId ? getLab(item.labId) : null;
  return (
    <li className="px-home-grid__item">
      <a className="px-card px-home-card" data-ratio="1:1" href={formatRoute({ name: "library", itemId: item.id })}>
        <span className="px-card__thumb" style={lab ? cssVars({ "--_tint": labTint(lab) }) : undefined}>
          <AssetThumbnail assetId={item.thumbnailAssetId} placeholder={<LabPlaceholder lab={lab} />} />
        </span>
        <span className="px-card__text">
          <span className="px-card__title">{item.title}</span>
          <span className="px-card__subtitle">
            {libraryKindName(item.kind)}
            {lab ? ` · ${lab.title}` : ""}
          </span>
        </span>
      </a>
    </li>
  );
}
