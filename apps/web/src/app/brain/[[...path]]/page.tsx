import { BrainWorkbench } from '@/components/brain/wiki/workbench';
import { refOfPath } from '@/lib/shared/brain-files';

/**
 * /brain: the second brain as a repository of Markdown files in a workbench (docs/second-brain.md#the-brain-page).
 * `/brain` opens index.md, `/brain/log` log.md, `/brain/settings` What Landflow knows, `/brain/<type>/<id>` a page. One
 * route for all of them, so moving between files keeps the workbench.
 */
export default async function BrainPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return <BrainWorkbench initial={refOfPath(path)} />;
}
