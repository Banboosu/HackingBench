import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { redact } from './safety.js';

export class Journal {
  constructor(private folder: string, private secrets: string[]) {}
  append(file: 'events.jsonl' | 'commands.jsonl', record: unknown): void {
    const encoded = JSON.stringify({ at: new Date().toISOString(), record }, (key, value) => {
      if (key === 'data' && typeof value === 'string' && value.length > 100000) return '[large binary payload omitted]';
      return typeof value === 'string' ? redact(value, this.secrets) : value;
    });
    appendFileSync(path.join(this.folder, file), encoded + '\n', { mode: 0o600 });
  }
}
