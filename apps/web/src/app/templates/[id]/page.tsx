import { Suspense } from 'react';
import { TemplateView } from '@/components/templates/template-view';

/** /templates/:id — one template, with a preview and "Use template". */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <TemplateView key={id} id={decodeURIComponent(id)} />
    </Suspense>
  );
}
