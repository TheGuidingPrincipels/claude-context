import * as fs from 'fs/promises';
import * as path from 'path';

export interface DaemonLockHandle {
  lockFilePath: string;
  pidFilePath: string;
  pid: number;
  release: () => Promise<void>;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // On POSIX systems, EPERM means the process exists but we lack permission to signal it.
    // Treat as alive to avoid starting a second daemon.
    if (error?.code === 'EPERM') return true;
    // ESRCH means no such process.
    if (error?.code === 'ESRCH') return false;
    // Be conservative: assume alive if we can't determine reliably.
    return true;
  }
}

async function readLockPid(lockFilePath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(lockFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    const pid =
      typeof parsed?.pid === 'number' ? parsed.pid : parseInt(String(parsed?.pid || ''), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function acquireDaemonLock(params: {
  lockFilePath: string;
  pidFilePath: string;
}): Promise<
  { acquired: false; reason: 'already_running' } | { acquired: true; handle: DaemonLockHandle }
> {
  const { lockFilePath, pidFilePath } = params;
  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
  await fs.mkdir(path.dirname(pidFilePath), { recursive: true });

  const pid = process.pid;
  const startedAt = new Date().toISOString();

  const tryCreate = async (): Promise<boolean> => {
    try {
      const fd = await fs.open(lockFilePath, 'wx');
      try {
        await fd.writeFile(JSON.stringify({ pid, startedAt }) + '\n', 'utf8');
      } finally {
        await fd.close();
      }
      await fs.writeFile(pidFilePath, `${pid}\n`, 'utf8');
      return true;
    } catch (error: any) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };

  const created = await tryCreate();
  if (!created) {
    const existingPid = await readLockPid(lockFilePath);
    if (existingPid && isPidAlive(existingPid)) {
      return { acquired: false, reason: 'already_running' };
    }

    // Stale lock: best-effort cleanup then retry once.
    try {
      await fs.unlink(lockFilePath);
    } catch {
      // Lock file already removed or doesn't exist - this is OK during stale lock cleanup
    }
    try {
      await fs.unlink(pidFilePath);
    } catch {
      // PID file already removed or doesn't exist - this is OK during stale lock cleanup
    }

    const retryCreated = await tryCreate();
    if (!retryCreated) {
      const retryPid = await readLockPid(lockFilePath);
      if (retryPid && isPidAlive(retryPid)) {
        return { acquired: false, reason: 'already_running' };
      }
      throw new Error(`Failed to acquire daemon lock at '${lockFilePath}' (unknown state)`);
    }
  }

  const release = async () => {
    try {
      await fs.unlink(lockFilePath);
    } catch {
      // Lock file already removed or doesn't exist - this is OK during release
    }
    try {
      await fs.unlink(pidFilePath);
    } catch {
      // PID file already removed or doesn't exist - this is OK during release
    }
  };

  return {
    acquired: true,
    handle: {
      lockFilePath,
      pidFilePath,
      pid,
      release,
    },
  };
}

export async function isDaemonLockHeld(
  lockFilePath: string
): Promise<{ held: false } | { held: true; pid: number }> {
  const pid = await readLockPid(lockFilePath);
  if (!pid) return { held: false };
  return isPidAlive(pid) ? { held: true, pid } : { held: false };
}
