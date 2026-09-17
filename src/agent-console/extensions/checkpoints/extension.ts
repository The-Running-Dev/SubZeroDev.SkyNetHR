import type { Checkpoints, ResolvedPath, SessionId, TurnId } from '../../core/types.js';

const schema = (properties: Record<string, unknown>, required: string[]) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties, required, additionalProperties: false,
});

/** Pure runtime hooks. The core owns busy slots, reservations and event ordering. */
export function createCheckpointExtension(checkpoints: Checkpoints) {
  return {
    hooks: {
      beforeCreate() {},
      afterCreate: (sessionId: SessionId, cwd: ResolvedPath) => checkpoints.init(sessionId, cwd),
      beforeTurn: (sessionId: SessionId, cwd: ResolvedPath, turnId: TurnId) => checkpoints.commit(sessionId, cwd, `before turn ${turnId}`),
      afterTurn() {},
    },
    operations: {
      'checkpoints.list': { mutates: false, schema: schema({}, []), run: (...args: Parameters<Checkpoints['list']>) => checkpoints.list(...args) },
      'checkpoints.restore': { mutates: true, schema: schema({ sha: { type: 'string', pattern: '^[0-9a-f]{40}$' } }, ['sha']), run: (...args: Parameters<Checkpoints['restore']>) => checkpoints.restore(...args) },
    },
    destroy: (...args: Parameters<Checkpoints['destroy']>) => checkpoints.destroy(...args),
  };
}
