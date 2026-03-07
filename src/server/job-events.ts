import { EventEmitter } from 'node:events';
import type { JobEvent, JobLogEvent, JobRecord } from '../shared/types.js';

export class JobEvents {
  private readonly emitter = new EventEmitter();

  emitRecord(record: JobRecord): void {
    const event: JobEvent = { type: 'record', record };
    this.emitter.emit(record.id, event);
  }

  emitLog(log: JobLogEvent): void {
    const event: JobEvent = { type: 'log', log };
    this.emitter.emit(log.jobId, event);
  }

  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    this.emitter.on(jobId, listener);
    return () => this.emitter.off(jobId, listener);
  }
}

