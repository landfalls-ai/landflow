import { Suspense } from 'react';
import { AccessPage } from '@/components/access/access-page';

/** /access: ask for access, decide what is asked of you, see and end grants, edit the catalog (docs/access-requests.md). */
export default function AccessRoute() {
  return (
    <Suspense>
      <AccessPage />
    </Suspense>
  );
}
