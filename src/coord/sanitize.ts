// Sanitization for cross-session text at the context-injection sinks (finding 10).
//
// Journal msgs, plan summaries/excerpts, commit subjects, session ids, and claim
// paths all flow verbatim from the shared on-disk store into OTHER sessions'
// injected context (additionalContext). That channel is the product — it stays
// inherently injectable, and repolith does not try to adjudicate meaning. What it
// MUST NOT pass through is transport-level control: ANSI escapes that restyle or
// overwrite the receiving terminal, and control characters (CR, LF, NUL, …) that
// let one record fake line boundaries or split another's rendering. Every renderer
// that interpolates store-sourced text into a context line runs it through
// cleanContext first.
//
// RegExp-constructor form (not literals) so the source stays printable ASCII — a
// literal ESC byte inside a regex literal is exactly the class of character this
// module exists to keep out of files.

// ESC-introduced sequences — CSI (ESC [ … final byte), OSC (ESC ] … BEL/ST), then any
// stray two-char escape. Whole sequences are stripped so ESC[31m doesn't leak "[31m".
const ANSI = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?|\\u001b[@-_]?', 'g');
// C0 controls + DEL (tab/newline included — sinks render single lines).
const CTRL = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');

/** One store-sourced string, made safe for a single injected context line:
 *  ANSI stripped, control chars collapsed to a space, length capped with an ellipsis. */
export function cleanContext(s: string, max = 300): string {
  const t = s.replace(ANSI, '').replace(CTRL, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}
