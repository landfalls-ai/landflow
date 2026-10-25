import { Suspense } from 'react';
import { ProjectPage } from '@/components/projects/project-page';

/** /projects/:id — a project's workflows, credentials, data tables, agents and settings (`?tab=`, read with useSearchParams). */
export default async function ProjectRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ProjectPage key={id} projectId={decodeURIComponent(id)} />
    </Suspense>
  );
}
