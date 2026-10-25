/**
 * Owner from the environment, for Docker and CI: with LANDFLOW_OWNER_EMAIL and LANDFLOW_OWNER_PASSWORD (and
 * optionally LANDFLOW_OWNER_NAME) set, boot creates the owner if there is no user yet. Once any user exists the
 * variables are ignored (change the password in the app, not here).
 */
import { logger } from '../telemetry';
import { createOwner, setupRequired } from './users';

export async function bootstrapOwnerFromEnv(): Promise<void> {
  const email = process.env.LANDFLOW_OWNER_EMAIL?.trim();
  const password = process.env.LANDFLOW_OWNER_PASSWORD;
  if (!email && !password) return;
  if (!email || !password) {
    logger.warn('set both LANDFLOW_OWNER_EMAIL and LANDFLOW_OWNER_PASSWORD to create the owner at boot');
    return;
  }
  try {
    if (!setupRequired()) return;
    const owner = await createOwner({ email, password, name: process.env.LANDFLOW_OWNER_NAME?.trim() || 'Owner' });
    if (password.length < 8) logger.warn('LANDFLOW_OWNER_PASSWORD is shorter than 8 characters: change it after signing in');
    logger.info('created the owner from LANDFLOW_OWNER_EMAIL', { 'landflow.user.id': owner.id });
  } catch (error) {
    logger.error('creating the owner from LANDFLOW_OWNER_EMAIL failed', { error });
  }
}
