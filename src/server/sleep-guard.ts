import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Prevents macOS system sleep while jobs are active by managing a
 * `caffeinate -s` process.  The `-s` flag creates a system sleep assertion
 * that is automatically ignored on battery power, so we won't drain a
 * laptop to zero while the user is away.
 *
 * On non-Darwin platforms the guard is a silent no-op.
 */
export class SleepGuard {
  private refCount = 0;
  private child: ChildProcess | null = null;
  private readonly enabled: boolean;

  constructor(platform: string = process.platform) {
    this.enabled = platform === 'darwin';
  }

  acquire(): void {
    this.refCount += 1;
    if (this.refCount === 1) {
      this.spawnCaffeinate();
    }
  }

  release(): void {
    if (this.refCount <= 0) {
      return;
    }
    this.refCount -= 1;
    if (this.refCount === 0) {
      this.killCaffeinate();
    }
  }

  dispose(): void {
    this.refCount = 0;
    this.killCaffeinate();
  }

  /** Visible for testing. */
  get active(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Visible for testing. */
  get refs(): number {
    return this.refCount;
  }

  private spawnCaffeinate(): void {
    if (!this.enabled || this.child) {
      return;
    }

    try {
      this.child = spawn('caffeinate', ['-s'], {
        stdio: 'ignore',
        detached: false,
      });

      // Don't let the child keep the Node process alive on crash/exit.
      this.child.unref();

      this.child.on('error', () => {
        // caffeinate not found or spawn failure — non-fatal.
        this.child = null;
      });

      this.child.on('exit', () => {
        this.child = null;
      });
    } catch {
      // Spawn itself threw — non-fatal.
      this.child = null;
    }
  }

  private killCaffeinate(): void {
    if (!this.child) {
      return;
    }

    try {
      this.child.kill('SIGTERM');
    } catch {
      // Already dead or permission error — ignore.
    }
    this.child = null;
  }
}
