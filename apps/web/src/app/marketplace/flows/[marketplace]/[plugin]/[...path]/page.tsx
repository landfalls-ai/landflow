import { Suspense } from 'react';
import { FlowView } from '@/components/marketplace/flow-view';

/** /marketplace/flows/:marketplace/:plugin/:path… — a marketplace flow's share page (read only; Install, no run). */
export default async function MarketplaceFlowPage({ params }: { params: Promise<{ marketplace: string; plugin: string; path: string[] }> }) {
  const { marketplace, plugin, path } = await params;
  const file = path.map(decodeURIComponent).join('/');
  return (
    <Suspense>
      <FlowView key={`${marketplace}/${plugin}/${file}`} marketplace={decodeURIComponent(marketplace)} plugin={decodeURIComponent(plugin)} path={file} />
    </Suspense>
  );
}
