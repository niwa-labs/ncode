import { posix, win32 } from 'node:path';

const TERMINAL_IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);

/**
 * Resolves a pasted value into attachment references.
 * `undefined` — not an attachment paste (plain text); otherwise one or more
 * file references to attach, already unescaped where splitting applied.
 * A multi-file drop wins over the whole-string reading (the concatenation of
 * several .png paths also LOOKS like one absolute .png path); a single path
 * with bare spaces inside (an unquoted Windows filename) fails the
 * every-token test and falls back to the whole-string reference.
 */
export function resolveTuiTerminalPasteReferences(value: string): string[] | undefined {
  const references = splitTuiTerminalPastePaths(value);
  if (references.length > 1 && references.every(isSingleImagePathPaste)) {
    return references;
  }
  // The single-path case passes the value VERBATIM (quotes included — the
  // attachment resolver strips them itself), exactly as the paste handler
  // always did before multi-file support.
  if (isSingleImagePathPaste(value)) return [value];
  return undefined;
}

export function isTuiTerminalImagePaste(value: string): boolean {
  return resolveTuiTerminalPasteReferences(value) !== undefined;
}

/**
 * Splits a pasted value into individual file references.
 *
 * Dragging N files from Finder drops them as ONE line of space-separated
 * absolute paths (filenames with spaces arrive backslash-escaped by the
 * terminal), so the paste handler must never treat the whole line as a single
 * path — a 3-file drop used to stat the concatenation and fail with ENOENT.
 * A backslash-escaped space belongs to the token; bare whitespace separates.
 * Values with line breaks are not path pastes and split into nothing.
 */
export function splitTuiTerminalPastePaths(value: string): string[] {
  const trimmed = stripMatchingQuotes(value.trim());
  if (!trimmed || /[\r\n]/u.test(trimmed)) return [];
  const tokens: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    const next = trimmed[index + 1];
    // A backslash escapes only whitespace and itself (the terminal's escaping
    // of spaces in dropped filenames); any other backslash is a path
    // separator and must survive verbatim (Windows paths).
    if (char === '\\' && (next === '\\' || (next !== undefined && /\s/u.test(next)))) {
      current += next;
      index += 1;
    } else if (/\s/u.test(char)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function isSingleImagePathPaste(value: string): boolean {
  const trimmed = stripMatchingQuotes(value.trim());
  if (!trimmed || /[\r\n]/u.test(trimmed)) return false;
  const normalized = trimmed.replaceAll('\\', '/');
  if (
    !normalized.includes('/otty-paste/') &&
    !posix.isAbsolute(normalized) &&
    !win32.isAbsolute(trimmed)
  ) {
    return false;
  }
  const extension = posix.extname(normalized).toLocaleLowerCase();
  return TERMINAL_IMAGE_EXTENSIONS.has(extension);
}

export function getTuiTerminalImagePasteFallbackPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const trimmed = value.trim();
  if (
    platform === 'win32' ||
    !isTuiTerminalImagePaste(trimmed) ||
    !posix.isAbsolute(trimmed) ||
    win32.parse(trimmed).root !== posix.parse(trimmed).root
  ) {
    return undefined;
  }
  const unescaped = trimmed.replace(/\\([\\ ])/gu, '$1');
  return unescaped === trimmed ? undefined : unescaped;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}
