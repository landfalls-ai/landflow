/**
 * Approve / reject links of approval emails (lib/server/approval-email.ts). Public (lib/shared/auth-paths.ts): the signed,
 * single-use token in the URL is the credential. GET shows a confirmation page (mail scanners open links); POST decides.
 * `handler` gives it the request id, audit context and error mapping; the path stays public, so the guard lets it through.
 */
import { handler } from '@/lib/server/http';
import { confirmationPage, decisionPage } from '@/lib/server/approval-email';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ token: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => confirmationPage((await params).token));

export const POST = handler(async (_request: Request, { params }: Ctx) => decisionPage((await params).token));
