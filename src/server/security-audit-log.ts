import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface SecurityAuditEvent {
  at: string;
  jobId: string;
  subsystem: string;
  action: string;
  args?: unknown;
  reason: string;
}

export class SecurityAuditLogger {
  async append(targetPath: string, event: Omit<SecurityAuditEvent, 'at'>): Promise<void> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await appendFile(targetPath, `${JSON.stringify({
      ...event,
      at: new Date().toISOString(),
    })}\n`, 'utf8');
  }
}
