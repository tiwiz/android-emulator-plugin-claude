// Session lifecycle for the shared runtime, read from the hook-maintained registry.
import { stateDir } from './config.mjs';
import { threadStates } from './sessions.mjs';

export async function threadInfo(threadIds) {
  return threadStates(stateDir(), threadIds);
}
