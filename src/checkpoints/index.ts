import { createCheckpoints as createRuntimeCheckpoints } from '../agent-console/extensions/checkpoints/index.js';
import type { Config, Checkpoints } from '../contract/index.js';
export { computeUnreached } from '../agent-console/extensions/checkpoints/index.js';

export function createCheckpoints(config: Config): Checkpoints {
  return createRuntimeCheckpoints(config, { name: 'skynet-hr', email: 'checkpoints@skynet-hr.local' });
}
