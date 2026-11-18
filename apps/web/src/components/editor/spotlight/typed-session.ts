/**
 * Re-check 3: two typed asks are the Test and fix session's, not the chat's (the chat has no run tool): a bare run ("Run it now",
 * with a trigger to start from) and output that looks wrong or made up ("The numbers in the summary look made up. Test it and
 * fix it."), which is judged against that sentence. The session takes its autonomy from the workflow (`autonomyOf`): a saved or
 * published one asks first, the switch notwithstanding. Returns whether the ask was taken.
 */
import { nanoid } from 'nanoid';
import { runAsk, wrongOutputAsk } from '@/lib/shared/spotlight';
import { useAssistant } from '../assistant';
import { useEditor } from '../store';
import { testUntilItRuns } from '../test-session';

export function startTypedSession(message: string): boolean {
  const { nodes, nodeTypes, description } = useEditor.getState();
  const wrong = wrongOutputAsk(message) && nodes.length > 0;
  const bare = runAsk(message) && nodes.some((n) => nodeTypes[n.data.wf.type]?.descriptor.kind === 'trigger');
  if (!wrong && !bare) return false;
  if (useAssistant.getState().pending || useAssistant.getState().testing) return true;
  useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }]);
  void testUntilItRuns(wrong ? message : description?.trim() || undefined);
  return true;
}
