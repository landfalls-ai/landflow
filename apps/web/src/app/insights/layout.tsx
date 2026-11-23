import { SectionNav } from '@/components/shell/section-nav';

/** The runs tab strip above the list pages here (it hides itself on a page of its own). */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionNav group="runs" />
      {children}
    </>
  );
}
