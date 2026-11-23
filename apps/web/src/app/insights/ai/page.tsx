import { Suspense } from 'react';
import { AiConsole } from '@/components/insights/ai-console';

/** /insights/ai: AI spend, caps and the gateway (docs/llm-gateway.md, "The AI page"). */
export default function AiPage() {
  // The view is read from the URL (useSearchParams needs a Suspense boundary).
  return (
    <Suspense>
      <AiConsole />
    </Suspense>
  );
}
