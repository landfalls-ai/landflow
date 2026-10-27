/**
 * Approve / reject links of approval emails (lib/server/approval-email.ts). Public (lib/shared/auth-paths.ts): the signed,
 * single-use token in the URL is the credential. GET shows a confirmation page (mail scanners open links); POST decides.
 */
import { confirmationPage, decisionPage } from '@/lib/server/approval-email';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  return confirmationPage((await params).token);
}

export async function POST(_request: Request, { params }: Ctx) {
  return decisionPage((await params).token);
}
