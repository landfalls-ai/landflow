'use client';
/**
 * The sidebar's project switcher: the project open now (on /projects/<id>), the viewer's personal project and the
 * team projects they belong to (owners and admins: every project), "All projects", and "New project" for those who
 * may create one.
 */
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronsUpDown, FolderCog, FolderKanban, LayoutGrid, Plus, UserRound, Users } from 'lucide-react';
import { can } from '@/lib/shared/auth';
import { cn } from '@/lib/utils';
import { useViewer } from '../auth/viewer';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '../ui/popover';
import { NewProjectDialog } from './project-dialogs';
import { projectLabel, useProjects } from './use-projects';

export function ProjectSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const viewer = useViewer();
  const { projects } = useProjects();
  const [creating, setCreating] = useState(false);
  const openId = pathname.startsWith('/projects/') ? decodeURIComponent(pathname.split('/')[2] ?? '') : undefined;
  const open = projects?.find((p) => p.id === openId);
  const personal = projects?.filter((p) => p.type === 'personal') ?? [];
  const team = projects?.filter((p) => p.type === 'team') ?? [];
  const mayCreate = viewer ? can(viewer, 'projects:manage') : false;

  return (
    <>
      <Popover
        align="start"
        className="w-[240px]"
        trigger={({ open: shown, toggle }) => (
          <button
            onClick={toggle}
            aria-label="Switch project"
            aria-expanded={shown}
            className={cn('mx-1 mb-1 flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-hair bg-sf px-2.5 text-left text-[13px] text-t1 transition-colors duration-[120ms] hover:border-bd', pathname.startsWith('/projects') && 'border-acbd')}
          >
            <FolderKanban className="size-4 shrink-0 text-t3" strokeWidth={1.7} />
            <span className="min-w-0 flex-1 truncate">{open ? projectLabel(open, viewer?.id) : 'All projects'}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-t3" />
          </button>
        )}
      >
        {(close) => (
          <div className="max-h-[60vh] overflow-y-auto">
            <MenuItem
              onClick={() => {
                close();
                router.push('/projects');
              }}
            >
              <LayoutGrid /> All projects
            </MenuItem>
            {personal.length > 0 && <MenuSeparator />}
            {personal.length > 0 && <MenuLabel>Personal</MenuLabel>}
            {personal.map((project) => (
              <ProjectLink key={project.id} href={`/projects/${encodeURIComponent(project.id)}`} active={project.id === openId} onClick={close} icon={<UserRound />}>
                {projectLabel(project, viewer?.id)}
              </ProjectLink>
            ))}
            {(team.length > 0 || mayCreate) && <MenuSeparator />}
            {(team.length > 0 || mayCreate) && <MenuLabel>Projects</MenuLabel>}
            {team.map((project) => (
              <ProjectLink key={project.id} href={`/projects/${encodeURIComponent(project.id)}`} active={project.id === openId} onClick={close} icon={<Users />}>
                {project.name}
              </ProjectLink>
            ))}
            {/* Always: Manage projects is never run on from the last project row. */}
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                close();
                router.push('/projects');
              }}
            >
              <FolderCog /> Manage projects
            </MenuItem>
            {mayCreate && (
              <MenuItem
                onClick={() => {
                  close();
                  setCreating(true);
                }}
              >
                <Plus /> New project…
              </MenuItem>
            )}
          </div>
        )}
      </Popover>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/projects/${encodeURIComponent(id)}`)} />}
    </>
  );
}

function ProjectLink({ href, active, onClick, icon, children }: { href: string; active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-t1 hover:bg-acdim [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-t3', active && 'bg-acdim font-semibold')}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  );
}
