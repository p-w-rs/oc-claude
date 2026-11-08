// Observe framing without parsing tool arguments, retaining prompt content, or
// rewriting valid bytes. Only short prefixes are buffered, even for huge SSE
// data lines. TextDecoder handles split UTF-8 and CRLF across network chunks.
export class StreamCompletion {
  private readonly decoder = new TextDecoder();
  private prefix = "";
  private event = "";
  private hasData = false;
  private carriageReturn = false;
  terminal = false;

  push(bytes: Uint8Array): void { this.scan(this.decoder.decode(bytes, { stream: true })); }
  finish(): boolean { this.scan(this.decoder.decode()); return this.terminal; }

  private scan(text: string): void {
    for (const char of text) {
      if (char === "\n" && this.carriageReturn) { this.carriageReturn = false; continue; }
      this.carriageReturn = char === "\r";
      if (char === "\r" || char === "\n") this.line();
      else if (this.prefix.length < 256) this.prefix += char;
    }
  }

  private line(): void {
    const line = this.prefix;
    this.prefix = "";
    if (!line) {
      if (this.hasData && ["message_stop", "error"].includes(this.event)) this.terminal = true;
      this.event = "";
      this.hasData = false;
    } else if (line.startsWith("event:")) {
      this.event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      this.hasData = true;
      if (!this.event) {
        const type = /^data:\s*\{\s*"type"\s*:\s*"(message_stop|error)"/.exec(line)?.[1];
        if (type) this.event = type;
      }
    }
  }
}
