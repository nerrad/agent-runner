import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import type { RuntimeConfig } from './config.js';
import type { McpServerManifestEntry } from './mcp-rewriter.js';

interface McpProcessState {
  name: string;
  process: ChildProcess;
  pid: number;
  alive: boolean;
  sseClients: Set<Response>;
  stdoutBuffer: string;
  messageEndpoint: string;
}

export interface McpServerStatus {
  name: string;
  pid: number;
  alive: boolean;
}

const CLEANUP_TIMEOUT_MS = 5_000;

export class McpBroker {
  private readonly processes = new Map<string, Map<string, McpProcessState>>();

  constructor(private readonly config: RuntimeConfig) {}

  async ensureProcess(jobId: string, serverName: string): Promise<McpProcessState> {
    let jobProcesses = this.processes.get(jobId);
    if (!jobProcesses) {
      jobProcesses = new Map();
      this.processes.set(jobId, jobProcesses);
    }

    const existing = jobProcesses.get(serverName);
    if (existing?.alive) {
      return existing;
    }

    const manifest = await this.readManifest(jobId);
    const entry = manifest.find((e) => e.name === serverName);
    if (!entry) {
      throw new Error(`MCP server '${serverName}' not found in manifest for job ${jobId}`);
    }

    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...entry.env,
    };

    const child = spawn(entry.command, entry.args, {
      env: processEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const state: McpProcessState = {
      name: serverName,
      process: child,
      pid: child.pid ?? 0,
      alive: true,
      sseClients: new Set(),
      stdoutBuffer: '',
      messageEndpoint: '',
    };

    child.stdout!.on('data', (data: Buffer) => {
      state.stdoutBuffer += data.toString();
      const lines = state.stdoutBuffer.split('\n');
      state.stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        for (const client of state.sseClients) {
          try {
            client.write(`event: message\ndata: ${line}\n\n`);
          } catch {
            // Client disconnected
          }
        }
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      // Log stderr but don't forward to SSE clients
      const text = data.toString().trim();
      if (text.length > 0) {
        // stderr from MCP server processes is informational; visible in host logs
      }
    });

    child.on('exit', (code, signal) => {
      state.alive = false;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      for (const client of state.sseClients) {
        try {
          client.write(`event: error\ndata: ${JSON.stringify({ error: `MCP server '${serverName}' exited (${reason})` })}\n\n`);
          client.end();
        } catch {
          // Client already disconnected
        }
      }
      state.sseClients.clear();
    });

    child.on('error', (error) => {
      state.alive = false;
      for (const client of state.sseClients) {
        try {
          client.write(`event: error\ndata: ${JSON.stringify({ error: `MCP server '${serverName}' error: ${error.message}` })}\n\n`);
          client.end();
        } catch {
          // Client already disconnected
        }
      }
      state.sseClients.clear();
    });

    jobProcesses.set(serverName, state);
    return state;
  }

  handleSseConnection(jobId: string, serverName: string, res: Response, brokerBaseUrl: string, token: string): void {
    const jobProcesses = this.processes.get(jobId);
    const state = jobProcesses?.get(serverName);
    if (!state?.alive) {
      res.status(502).json({ error: `MCP server '${serverName}' is not running` });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    state.sseClients.add(res);

    const messageUrl = `${brokerBaseUrl}/broker/jobs/${jobId}/mcp/${encodeURIComponent(serverName)}/message?token=${encodeURIComponent(token)}`;
    state.messageEndpoint = messageUrl;
    res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);

    res.on('close', () => {
      state.sseClients.delete(res);
    });
  }

  async handleMessage(jobId: string, serverName: string, body: unknown): Promise<void> {
    const jobProcesses = this.processes.get(jobId);
    const state = jobProcesses?.get(serverName);
    if (!state?.alive) {
      throw new Error(`MCP server '${serverName}' is not running`);
    }

    const jsonRpc = JSON.stringify(body);
    state.process.stdin!.write(jsonRpc + '\n');
  }

  async cleanupJob(jobId: string): Promise<void> {
    const jobProcesses = this.processes.get(jobId);
    if (!jobProcesses) {
      return;
    }

    const entries = [...jobProcesses.values()];
    for (const state of entries) {
      for (const client of state.sseClients) {
        try {
          client.end();
        } catch {
          // Already closed
        }
      }
      state.sseClients.clear();

      if (state.alive) {
        state.process.kill('SIGTERM');
      }
    }

    // Wait for graceful shutdown, then force kill survivors
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        for (const state of entries) {
          if (state.alive) {
            try {
              state.process.kill('SIGKILL');
            } catch {
              // Already dead
            }
          }
        }
        resolve();
      }, CLEANUP_TIMEOUT_MS);

      const checkAll = (): void => {
        if (entries.every((s) => !s.alive)) {
          clearTimeout(timeout);
          resolve();
        }
      };

      for (const state of entries) {
        if (!state.alive) {
          continue;
        }
        state.process.once('exit', checkAll);
      }

      checkAll();
    });

    this.processes.delete(jobId);
  }

  getJobStatus(jobId: string): { servers: McpServerStatus[] } {
    const jobProcesses = this.processes.get(jobId);
    if (!jobProcesses) {
      return { servers: [] };
    }

    const servers: McpServerStatus[] = [];
    for (const state of jobProcesses.values()) {
      servers.push({
        name: state.name,
        pid: state.pid,
        alive: state.alive,
      });
    }
    return { servers };
  }

  private async readManifest(jobId: string): Promise<McpServerManifestEntry[]> {
    const manifestPath = path.join(this.config.artifactsDir, jobId, 'mcp-manifest.json');
    const raw = await readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as McpServerManifestEntry[];
  }
}
