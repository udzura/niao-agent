export interface ModelOutput {
  content?: string;
  thinking?: string;
  thinkingActive?: boolean;
}
export interface ModelOutputAdapter {
  transform(chunk: string): ModelOutput;
  flush(): ModelOutput;
}
export class DefaultAdapter implements ModelOutputAdapter {
  transform(chunk: string): ModelOutput { return {content:chunk}; }
  flush(): ModelOutput { return {}; }
}
// Google Gemma 4: <|channel>thought\n ... <channel|>final answer.
// Buffer only delimiter prefixes or a bounded header, never the whole answer.
export class Gemma4Adapter implements ModelOutputAdapter {
  private buffer = '';
  private mode: 'content' | 'header' | 'thinking' = 'content';
  private seenThinking = false;
  private readonly open = '<|channel>';
  private readonly close = '<channel|>';
  transform(chunk: string): ModelOutput {
    this.buffer += chunk;
    const output: ModelOutput = {};
    const emit = (text: string) => {
      const field = this.mode === 'content' ? 'content' : 'thinking';
      output[field] = (output[field] ?? '') + text;
    };
    while (this.buffer) {
      if (this.mode === 'header') {
        const boundary = this.buffer.search(/[\s<]/);
        if (boundary === -1 && this.buffer.length <= 32) break;
        // Unknown/malformed channel names are treated conservatively as thinking.
        const end = boundary === -1 ? 32 : boundary;
        this.buffer = this.buffer.slice(end);
        if (this.buffer.startsWith('\r') && this.buffer.length === 1) break;
        if (this.buffer.startsWith('\r\n')) this.buffer = this.buffer.slice(2);
        else if (/^[\s]/.test(this.buffer)) this.buffer = this.buffer.slice(1);
        this.mode = 'thinking';
        continue;
      }
      if (this.buffer.startsWith(this.open)) {
        this.buffer = this.buffer.slice(this.open.length);
        this.mode = 'header'; this.seenThinking = true; output.thinkingActive = true;
      } else if (this.buffer.startsWith(this.close)) {
        this.buffer = this.buffer.slice(this.close.length);
        this.mode = 'content'; output.thinkingActive = false;
      } else if ([this.open,this.close].some(marker => marker.startsWith(this.buffer))) {
        break;
      } else if (this.buffer.startsWith('<|channel') || this.buffer.startsWith('<channel|')) {
        // Suppress malformed channel delimiters too. Keep the lookahead bounded.
        const end = this.buffer.indexOf('>');
        if (end === -1 && this.buffer.length <= 32) break;
        const opening = this.buffer.startsWith('<|channel');
        this.buffer = this.buffer.slice(end === -1 ? 32 : end + 1);
        this.mode = opening ? 'header' : 'content';
        if (opening) this.seenThinking = true;
        output.thinkingActive = opening;
      } else {
        const next = this.buffer.indexOf('<',1);
        if (this.buffer.startsWith('<')) { emit('<'); this.buffer = this.buffer.slice(1); }
        else { const end = next === -1 ? this.buffer.length : next; emit(this.buffer.slice(0,end)); this.buffer = this.buffer.slice(end); }
      }
    }
    return output;
  }
  flush(): ModelOutput {
    const output: ModelOutput = {};
    // A lone '<' is ordinary text; longer unfinished marker prefixes are withheld.
    if (this.mode !== 'header' && this.buffer === '<') output[this.mode] = this.buffer;
    this.buffer = '';
    if (this.seenThinking) output.thinkingActive = false;
    return output;
  }
}
// Qwen may expose reasoning as structured SSE fields or inline <think> tags.
// This streaming fallback never sends recognized reasoning tags into chat text.
export class QwenAdapter implements ModelOutputAdapter {
  private buffer = "";
  private thinking = false;
  private seen = false;
  transform(chunk: string): ModelOutput {
    this.buffer += chunk;
    const output: ModelOutput = {};
    const markers = ["<think>", "</think>"];
    while (this.buffer) {
      const marker = markers.find(value => this.buffer.startsWith(value));
      if (marker) {
        this.buffer = this.buffer.slice(marker.length);
        this.thinking = marker === "<think>"; this.seen = true;
        output.thinkingActive = this.thinking;
      } else if (markers.some(value => value.startsWith(this.buffer))) break;
      else {
        const next = this.buffer.indexOf("<", 1);
        const end = this.buffer.startsWith("<") ? 1 : next < 0 ? this.buffer.length : next;
        const field = this.thinking ? "thinking" : "content";
        output[field] = (output[field] ?? "") + this.buffer.slice(0,end);
        this.buffer = this.buffer.slice(end);
      }
    }
    return output;
  }
  flush(): ModelOutput {
    const output: ModelOutput = {};
    if (this.buffer === "<") output[this.thinking ? "thinking" : "content"] = this.buffer;
    if (this.seen) output.thinkingActive = false;
    this.buffer = "";
    return output;
  }
}
export function modelOutputAdapter(modelId: string): ModelOutputAdapter {
  return modelId.startsWith('@cf/google/gemma-4-') ? new Gemma4Adapter()
    : (modelId === '@cf/qwen/qwen3.8-27b' || modelId === '@cf/qwen/qwen3-30b-a3b-fp8') ? new QwenAdapter() : new DefaultAdapter();
}
