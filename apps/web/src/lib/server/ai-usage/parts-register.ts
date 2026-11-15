/** Sets the recorded-call listener (call-context.ts) to `writeParts`: a side-effect import at the top of lib/server/runtime.ts. */
import { setRecordedCallListener } from './call-context';
import { writeParts } from './parts';

setRecordedCallListener(writeParts);
