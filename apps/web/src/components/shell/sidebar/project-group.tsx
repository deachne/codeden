import type { Project, Session } from "@codeden/contracts";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { Link } from "@tanstack/react-router";
import { Archive, Bot, Check, ChevronRight, GripVertical, House, Plus } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { GitHubMark } from "@/components/common/github-mark";
import { StatusDot } from "@/components/common/status-dot";
import { projectAllQuiet, roleSessionFor, sessionTone } from "@/lib/format";
import { useSnapshotData } from "@/lib/queries";
import { sortSessionsByAttention } from "@/lib/session-order";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { ArchiveProjectDialog } from "./archive-project-dialog";
import { childGroup, childRow, NavRow, rowBase, useIsActive } from "./nav-row";
import { ProjectAutomations } from "./project-automations";
import { type GroupPosition, useProjectMenu } from "./project-menu";
import { RowMenu, RowMenuButton, useRowMenu } from "./row-menu";
import { SessionRow } from "./session-row";

const LIMIT = 5;

/** Project tile: initial on a tinted square. */
export function ProjectTile({ project, className }: { project: Project; className?: string }) {
  const hue = (project.slug.split("").reduce((h, c) => h + c.charCodeAt(0), 0) * 29) % 360;
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] text-3xs font-bold uppercase",
        className,
      )}
      style={{ background: `oklch(0.7 0.11 ${hue} / 0.2)`, color: `oklch(0.75 0.13 ${hue})` }}
      aria-hidden
    >
      {project.name.charAt(0)}
    </span>
  );
}

/** Drag wiring from `useSortable`, for a project row in a sortable list (§13). */
export interface ProjectDrag {
  setNodeRef: (element: HTMLElement | null) => void;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  style: CSSProperties;
  isDragging: boolean;
}

/**
 * One project in the sidebar: header, PM, sessions, automations and archived sessions. The
 * header row drags after a few pixels (so clicks still expand and open), a grip in the gutter
 * starts a keyboard move, and its row menu pins, unpins, moves and archives the project.
 */
export function ProjectGroup({
  project,
  sessions,
  drag,
  position,
}: {
  project: Project;
  sessions: Session[];
  drag: ProjectDrag;
  position: GroupPosition;
}) {
  const open = useLayoutStore((s) => s.expandedProjects[project.id] ?? false);
  const toggle = useLayoutStore((s) => s.toggleProject);
  const [showAll, setShowAll] = useState(false);
  const homeActive = useIsActive(`/projects/${project.id}`, false);
  const menu = useRowMenu();
  const [archiving, setArchiving] = useState(false);
  const entries = useProjectMenu(project, position, () => setArchiving(true));
  const pmRef = useSnapshotData((s) => s.roleSessions?.pms[project.id], undefined);
  const pm = roleSessionFor(sessions, "pm", project.id, pmRef);
  const agents = sortSessionsByAttention(
    sessions.filter((s) => s.role === "agent" && !s.archivedAt),
  );
  // Counted by the server: the snapshot carries only the recently archived sessions.
  const archived = useSnapshotData((s) => s.archivedSessionCounts[project.id] ?? 0, 0);
  const visible = showAll ? agents : agents.slice(0, LIMIT);
  const attention = agents.some(
    (s) => sessionTone(s.status, s.lastTurnStatus, s.role) === "waiting",
  );
  const allQuiet = projectAllQuiet(agents);
  const running = agents.filter(
    (s) => sessionTone(s.status, s.lastTurnStatus, s.role) === "running",
  ).length;

  return (
    <div
      ref={drag.setNodeRef}
      style={drag.style}
      data-project-id={project.id}
      className={cn(
        "flex flex-col gap-px",
        open && "pb-1.5",
        drag.isDragging &&
          "relative z-10 rounded-md bg-sidebar shadow-md ring-1 ring-sidebar-border",
      )}
    >
      <RowMenu menu={menu} entries={entries}>
        <div
          {...drag.listeners}
          className={cn(rowBase, "group/head pr-1", homeActive && "text-sidebar-accent-foreground")}
        >
          <button
            type="button"
            ref={drag.setActivatorNodeRef}
            {...drag.attributes}
            aria-label={`Reorder ${project.name}`}
            className="absolute top-1/2 -left-3 flex h-5 w-3 -translate-y-1/2 cursor-grab items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 outline-none transition-opacity group-hover/head:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring active:cursor-grabbing"
          >
            <GripVertical className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => toggle(project.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
            aria-expanded={open}
          >
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
                open && "rotate-90",
              )}
            />
            <ProjectTile project={project} />
            <span className="truncate font-medium">{project.name}</span>
            {allQuiet && (
              <span role="img" aria-label="All quiet" title="All quiet" className="shrink-0">
                <Check strokeWidth={3.5} className="size-3 text-status-done" aria-hidden />
              </span>
            )}
            {!open && (attention || running > 0) && (
              <span className="ml-auto flex items-center gap-1 pr-1">
                {attention && <span className="size-1.5 rounded-full bg-status-waiting" />}
                {running > 0 && (
                  <span className="text-3xs text-muted-foreground tabular-nums">{running}</span>
                )}
              </span>
            )}
          </button>
          {/* Actions never start a drag; the row around them does. */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="flex items-center opacity-0 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 touch:opacity-100"
          >
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="Project home"
            >
              <House className="size-3.5" />
            </Link>
            {project.kind === "github" && (
              <a
                href={`https://github.com/${project.github.owner}/${project.github.repo}`}
                target="_blank"
                rel="noreferrer"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
                title={`Open ${project.github.owner}/${project.github.repo} on GitHub`}
                aria-label={`Open ${project.github.owner}/${project.github.repo} on GitHub`}
                data-testid="project-github-link"
              >
                <GitHubMark className="size-3.5" />
              </a>
            )}
            <Link
              to="/projects/$projectId/new"
              params={{ projectId: project.id }}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="New session"
            >
              <Plus className="size-3.5" />
            </Link>
            <RowMenuButton menu={menu} entries={entries} label={`${project.name} actions`} />
          </div>
        </div>
      </RowMenu>
      <ArchiveProjectDialog
        project={project}
        sessions={sessions}
        open={archiving}
        onOpenChange={setArchiving}
      />

      {open && (
        <div className={childGroup}>
          <NavRow
            href={`/projects/${project.id}/pm`}
            link={{ to: "/projects/$projectId/pm", params: { projectId: project.id } }}
            className={childRow}
          >
            <Bot className="size-3.5 shrink-0 text-primary/80" />
            <span className="flex-1 truncate">Project manager</span>
            <span className="rounded-full bg-primary/10 px-1.5 text-3xs font-medium text-primary">
              PM
            </span>
            {pm && (
              <StatusDot
                status={pm.status}
                lastTurn={pm.lastTurnStatus}
                role={pm.role}
                sessionId={pm.id}
              />
            )}
          </NavRow>
          {visible.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
          {agents.length > LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className={cn(rowBase, childRow, "h-7 text-xs text-muted-foreground")}
            >
              {showAll ? "Show less" : `Show ${agents.length - LIMIT} more`}
            </button>
          )}
          <ProjectAutomations projectId={project.id} />
          {archived > 0 && (
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              search={{ archived: true }}
              className={cn(rowBase, childRow, "h-7 text-xs text-muted-foreground/70")}
            >
              <Archive className="size-3.5 shrink-0" />
              <span className="truncate">{archived} archived</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
