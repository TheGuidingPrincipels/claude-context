import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface CodebaseRunStatus {
  added: number;
  removed: number;
  modified: number;
  lastRunAt?: string;
  lastRunDurationMs?: number;
  lastError?: string;
}

export interface DaemonStatusFile {
  pid: number;
  startedAt: string;
  intervalMinutes: number;
  lastRunAt?: string;
  lastRunDurationMs?: number;
  lastError?: string;
  codebases: Record<string, CodebaseRunStatus>;
}

export function getDaemonStatusFilePath(): string {
  return path.join(os.homedir(), '.context', 'daemon-status.json');
}

export async function writeDaemonStatusFile(status: DaemonStatusFile): Promise<void> {
  const filePath = getDaemonStatusFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(status, null, 2), 'utf8');
}
