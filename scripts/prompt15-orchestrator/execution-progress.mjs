const executionTypes = new Set(['commandExecution', 'mcpToolCall', 'webSearch', 'fileChange', 'imageGeneration']);

// Model reasoning and notification heartbeats are not execution evidence.
export class ExecutionProgress {
  constructor(now = Date.now()) { this.lastExecutionAt = now; this.running = new Set(); this.startedAt = new Map(); }
  receive(method, item, now = Date.now()) {
    if (!executionTypes.has(item?.type) || !item.id || !['item/started', 'item/completed'].includes(method)) return;
    this.lastExecutionAt = now;
    if (method === 'item/started') { this.running.add(item.id); this.startedAt.set(item.id,now); }
    else { this.running.delete(item.id); this.startedAt.delete(item.id); }
  }
  isIdle(now, limitMs) {
    if(limitMs<=0)return false;
    if(!this.running.size)return now-this.lastExecutionAt>=limitMs;
    // A missing tool/completed event cannot disable the watchdog forever.
    // Allow real long checks a bounded 60 minutes (or twice configured idle).
    return [...this.startedAt.values()].some(start=>now-start>=Math.max(3600000,limitMs*2));
  }
}
