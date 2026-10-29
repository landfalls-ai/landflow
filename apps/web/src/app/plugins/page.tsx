import { Suspense } from 'react';
import { PluginRegistry } from '@/components/plugins/plugin-registry';

/** /plugins — the plugin registry. It reads `?plugin=` (the card to unfold) with useSearchParams, so it renders inside a Suspense boundary. */
export default function PluginsPage() {
  return (
    <Suspense>
      <PluginRegistry />
    </Suspense>
  );
}
