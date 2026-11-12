import { BrainPage } from '@/components/brain/wiki/brain-page';

/** /brain/:type/:id: one page of the brain — an initiative, person, customer or system (docs/second-brain.md#the-brain-page). */
export default async function BrainEntityPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  return <BrainPage key={`${type}/${id}`} type={type} id={decodeURIComponent(id)} />;
}
