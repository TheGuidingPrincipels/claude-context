import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Manages environment variable loading with fallback chain:
 * 1. process.env (highest priority)
 * 2. ~/.zshrc (only for secret-style vars: *_API_KEY, *_TOKEN, *_PAT)
 * 3. ~/.context/.env
 * 4. undefined (if not found anywhere)
 *
 * Note: Shell RC fallback currently only supports ~/.zshrc (macOS/zsh).
 * Bash users should set environment variables in ~/.context/.env instead.
 */
export class EnvManager {
  private envFilePath: string;
  /** Path to ~/.zshrc. Currently zsh-only; bash users should use ~/.context/.env */
  private zshrcPath: string;

  constructor() {
    const homeDir = os.homedir();
    this.envFilePath = path.join(homeDir, '.context', '.env');
    this.zshrcPath = path.join(homeDir, '.zshrc');
  }

  /**
   * Get environment variable by name
   * Priority:
   * 1) process.env
   * 2) ~/.zshrc (only for secret-style vars like *_API_KEY, *_TOKEN, *_PAT)
   * 3) ~/.context/.env
   * 4) undefined
   */
  get(name: string): string | undefined {
    // First try to get from process environment variables
    if (process.env[name]) {
      return process.env[name];
    }

    // Shell fallback for sensitive variables (e.g., API keys / tokens) when the process
    // was not started from an interactive shell that sourced ~/.zshrc.
    //
    // Intentionally narrow: do not read arbitrary config values from shell rc files to
    // keep runtime behavior predictable and avoid surprising test environments.
    if (this.shouldReadFromZshrc(name)) {
      const value = this.getFromZshrc(name);
      if (value !== undefined) {
        return value;
      }
    }

    // If not found in process env, try to read from .env file
    try {
      if (fs.existsSync(this.envFilePath)) {
        const content = fs.readFileSync(this.envFilePath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith(`${name}=`)) {
            return trimmedLine.substring(name.length + 1);
          }
        }
      }
    } catch (error) {
      // Ignore file read errors
    }

    return undefined;
  }

  /**
   * Only read from zshrc for secret-style environment variables.
   * This prevents accidentally parsing unrelated shell config and
   * limits the security surface.
   */
  private shouldReadFromZshrc(name: string): boolean {
    // Only secrets (opt-in by naming convention).
    return name.endsWith('_API_KEY') || name.endsWith('_TOKEN') || name.endsWith('_PAT');
  }

  private getFromZshrc(name: string): string | undefined {
    try {
      if (!fs.existsSync(this.zshrcPath)) return undefined;
      const content = fs.readFileSync(this.zshrcPath, 'utf-8');
      const lines = content.split('\n');

      // Shell semantics: last assignment wins.
      let found: string | undefined;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const match = trimmed.match(new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`));
        if (!match) continue;

        const raw = match[1] || '';
        const value = this.parseShellValue(name, raw);
        if (value !== undefined) {
          found = value;
        }
      }

      return found;
    } catch (error) {
      // Best-effort only; do not throw for optional shell fallback.
      console.warn(
        `[EnvManager] ⚠️ Failed to read ${name} from ~/.zshrc (${this.zshrcPath}): ${error}`
      );
      return undefined;
    }
  }

  /**
   * Parses a shell assignment value, respecting quotes, escapes and stripping inline comments.
   * Refuses dynamic shell expressions ($VAR, $(...), `...`).
   */
  private parseShellValue(name: string, raw: string): string | undefined {
    let value = '';
    let quote: '"' | "'" | null = null;
    let i = 0;

    // Skip leading whitespace in the value part (e.g. export KEY=  "val")
    const input = raw.trim();
    if (!input) return undefined;

    while (i < input.length) {
      const ch = input[i];

      // Handle escapes
      if (ch === '\\' && quote !== "'") {
        if (i + 1 < input.length) {
          const next = input[i + 1];
          // In shell double quotes, backslash only escapes specific characters: ", \, $, `, and newline.
          if (quote === '"') {
            if (next === '"' || next === '\\' || next === '$' || next === '`') {
              value += next;
              i += 2;
            } else {
              // Not a special char to escape, keep both backslash and next char
              value += ch;
              i++;
            }
          } else {
            // Outside quotes, backslash escapes everything (it vanishes but literalizes next char)
            value += next;
            i += 2;
          }
          continue;
        }
      }

      // Handle comments
      if (quote === null && ch === '#') break;

      // Handle trailing semicolon (common in shell scripts)
      if (quote === null && ch === ';') break;

      // Handle quotes
      if (quote === null && (ch === '"' || ch === "'")) {
        quote = ch;
        i++;
        continue;
      }
      if (quote !== null && ch === quote) {
        quote = null;
        i++;
        continue;
      }

      // Refuse shell interpolation
      if ((ch === '$' || ch === '`') && quote !== "'") {
        console.warn(
          `[EnvManager] ⚠️ Found ${name} in ~/.zshrc, but it appears to use shell interpolation. ` +
            `Set a literal value or put it in ~/.context/.env.`
        );
        return undefined;
      }

      value += ch;
      i++;
    }

    // After parsing, if we are still inside a quote, it was malformed.
    // But we'll just return what we got or trim it.
    return value.trim() || undefined;
  }

  /**
   * Helper to parse "truthy" environment variable values.
   */
  public isTruthy(name: string): boolean {
    const value = this.get(name);
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return (
      normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
    );
  }

  /**
   * Set environment variable to the .env file
   */
  set(name: string, value: string): void {
    try {
      // Ensure directory exists
      const envDir = path.dirname(this.envFilePath);
      if (!fs.existsSync(envDir)) {
        fs.mkdirSync(envDir, { recursive: true });
      }

      let content = '';
      let found = false;

      // Read existing content if file exists
      if (fs.existsSync(this.envFilePath)) {
        content = fs.readFileSync(this.envFilePath, 'utf-8');

        // Update existing variable
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith(`${name}=`)) {
            // Replace the existing value
            lines[i] = `${name}=${value}`;
            found = true;
            console.log(`[EnvManager] ✅ Updated ${name} in ${this.envFilePath}`);
            break;
          }
        }
        content = lines.join('\n');
      }

      // If variable not found, append it
      if (!found) {
        if (content && !content.endsWith('\n')) {
          content += '\n';
        }
        content += `${name}=${value}\n`;
        console.log(`[EnvManager] ✅ Added ${name} to ${this.envFilePath}`);
      }

      fs.writeFileSync(this.envFilePath, content, 'utf-8');
    } catch (error) {
      console.error(`[EnvManager] ❌ Failed to write env file: ${error}`);
      throw error;
    }
  }

  /**
   * Get the path to the .env file
   */
  getEnvFilePath(): string {
    return this.envFilePath;
  }
}

// Export a default instance for convenience
export const envManager = new EnvManager();
