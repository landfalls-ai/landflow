/** DELETE /api/workflows/:id/schedules/:scheduleId — cancel a scheduled publish that has not run (who scheduled it, or an owner or admin). */
import { requireUser } from '@/lib/server/auth/guard';
import { error, handler, json } from '@/lib/server/http';
import { cancelSchedule, ScheduleError } from '@/lib/server/publish-schedule';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; scheduleId: string }> };

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id, scheduleId } = await params;
  const user = await requireUser();
  try {
    return json({ scheduled: cancelSchedule(scheduleId, user, id) });
  } catch (caught) {
    if (caught instanceof ScheduleError) return error(caught.message, caught.status);
    throw caught;
  }
});
