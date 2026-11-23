/**
 * The deployment profile. `production` is what a deployed host runs; `development` relaxes the checks that would refuse
 * development secrets. LANDFLOW_PROFILE decides when valid; otherwise NODE_ENV=production means production. The in-repo
 * compose and Kubernetes stacks set LANDFLOW_PROFILE=development because their images set NODE_ENV=production while
 * running the development secrets from deploy/.env.example.
 */
export type Profile = 'development' | 'production';

export function profile(env: NodeJS.ProcessEnv = process.env): Profile {
  const explicit = env.LANDFLOW_PROFILE?.trim().toLowerCase();
  if (explicit === 'development' || explicit === 'production') return explicit;
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

export const isProduction = (env: NodeJS.ProcessEnv = process.env): boolean => profile(env) === 'production';
