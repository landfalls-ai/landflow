import { SectionNav } from '@/components/shell/section-nav';

/** The Projects | Goals tab strip above the goals page. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionNav group="projects" />
      {children}
    </>
  );
}
