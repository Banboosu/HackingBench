import { StringDecoder } from 'node:string_decoder';

/** UTF-8 safe, LF-only framing; U+2028/U+2029 are valid JSON string contents. */
export class JsonLines {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private onRecord: (record: any) => void, private maxBytes = 8 * 1024 * 1024) {}
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error('JSONL frame exceeds limit.');
      if (line.length) this.onRecord(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error('Unterminated JSONL frame exceeds limit.');
  }
}
