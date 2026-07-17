/*
 * Compatibility baseline copied from the generated phase declarations at
 * a3095837a62acdeac1922eecfdf38890437eb116, immediately before the v5
 * owned-lifecycle work. Keep this artifact independent of current sources.
 */
export type PipelineEvent =
  | { type: 'phase'; phase: string; detail?: string; counts?: Record<string, number> }
  | { type: 'content'; content: string }
  | { type: 'agent_activity'; agent: string; action: string; detail?: string }
  | { type: 'tool_call'; toolName: string; toolUseId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string }
  | { type: 'data'; key: string; value: unknown }
  | { type: 'phase_complete'; phase: string; checkpointKey: string }
  | { type: 'done'; reason?: string }
  | { type: 'cancellation_requested'; reason: string }
  | { type: 'cancelled'; reason: string }
  | { type: 'abandoned'; reason: string }
  | { type: 'error'; message: string };
