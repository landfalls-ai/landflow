import { PageBody, PageHeader } from '@/components/shell/page-header';
import { ConnectHarness } from '@/components/connect/connect-harness';

/** /connect: connect your own harness (Claude Code, Cursor, Codex CLI, Gemini CLI, VS Code, any MCP client) with a brain key. */
export default function ConnectPage() {
  return (
    <>
      <PageHeader title="Connect your harness" meta={<span>Copy-paste setup and a key for your own tools</span>} />
      <PageBody width="narrow">
        <p className="mb-5 max-w-[72ch] text-[13px] leading-relaxed text-t2">
          Your coding tool gets Landflow&apos;s tools and your own brain: yesterday&apos;s work at the start of a session, and a place to record today&apos;s. The key acts as you and is limited to what you tick.
        </p>
        <ConnectHarness />
      </PageBody>
    </>
  );
}
