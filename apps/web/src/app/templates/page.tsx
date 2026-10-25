import { Suspense } from 'react';
import { TemplateLibrary } from '@/components/templates/template-library';

/** /templates — the templates library. It reads `?folder=` and `?category=` with useSearchParams, so it renders inside a Suspense boundary. */
export default function TemplatesPage() {
  return (
    <Suspense>
      <TemplateLibrary />
    </Suspense>
  );
}
