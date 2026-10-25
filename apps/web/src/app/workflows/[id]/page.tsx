import { Editor } from '@/components/editor/editor';

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  return <Editor workflowId={(await params).id} />;
}
