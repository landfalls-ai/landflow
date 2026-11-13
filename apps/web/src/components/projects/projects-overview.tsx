'use client';
/** /projects: the viewer's personal project and the team projects they belong to (owners and admins: all of them). */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, UserRound, Users } from 'lucide-react';
import { can } from '@/lib/shared/auth';
import { useViewer } from '@/components/auth/viewer';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { describeCounts, NewProjectDialog } from './project-dialogs';
import { projectLabel, useProjects } from './use-projects';
import { plural } from '@/lib/client/format';

export function ProjectsOverview() {
  const router = useRouter();
  const viewer = useViewer();
  const { projects, error } = useProjects();
  const [creating, setCreating] = useState(false);
  const mayCreate = viewer ? can(viewer, 'projects:manage') : false;

  return (
    <>
      <PageHeader
        title="Projects"
        meta={projects && <span>{plural(projects.length, 'project')}</span>}
        actions={
          mayCreate && (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> New project
            </Button>
          )
        }
      />
      <PageBody width="narrow">
        {error && <div className="mb-4 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        <p className="mb-4 text-[12px] text-t3">
          Every workflow, credential, data table and agent belongs to one project. Your personal project holds what you create; team projects share their items with their members as admin, editor or viewer.
        </p>
        {projects && projects.length === 0 ? (
          <Card>
            <EmptyState title="No projects yet" />
          </Card>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {(projects ?? []).map((project) => {
              const Icon = project.type === 'personal' ? UserRound : Users;
              return (
                <Link key={project.id} href={`/projects/${encodeURIComponent(project.id)}`} className="flex flex-col gap-2 rounded-2xl border border-hair bg-sf px-4 py-3.5 transition-colors hover:border-ac">
                  <div className="flex items-center gap-2.5">
                    <Icon className="size-4 shrink-0 text-t3" strokeWidth={1.7} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-t1">{projectLabel(project, viewer?.id)}</span>
                    {project.role && <Badge tone={project.role === 'admin' ? 'accent' : 'muted'}>{project.role}</Badge>}
                  </div>
                  {project.description && <p className="line-clamp-2 text-[12px] text-t2">{project.description}</p>}
                  <p className="text-[12px] text-t3">
                    {describeCounts(project.counts) || 'Empty'} · {project.memberCount} {project.memberCount === 1 ? 'member' : 'members'}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </PageBody>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/projects/${encodeURIComponent(id)}`)} />}
    </>
  );
}
