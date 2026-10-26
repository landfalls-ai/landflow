'use client';
/**
 * The project the viewer works in last (a project page they opened, the project picked on the workflows or templates
 * list), remembered in this browser only. The Templates page starts on it: that project's templates and the
 * instance-wide ones. Never authoritative: the server checks every project id.
 */
const KEY = 'landflow-current-project';

export function rememberProject(projectId: string | undefined) {
  try {
    if (projectId) localStorage.setItem(KEY, projectId);
    else localStorage.removeItem(KEY);
  } catch {}
}

export function rememberedProject(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
