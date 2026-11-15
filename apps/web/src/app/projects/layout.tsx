import { SectionNav } from '@/components/shell/section-nav';

/** The Projects | Goals tab strip above the projects list (a project page shows none). */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionNav group="projects" />
      {children}
    </>
  );
}
