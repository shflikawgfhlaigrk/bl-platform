import { ApiError } from '@blacklabel/core';

/** Independent file limit; this worktree also caps completion JSON at 5MiB. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ENCODED_BYTES = 4 * Math.ceil(MAX_FILE_BYTES / 3);

export function assertFileSize(size: number): void {
  if (size > MAX_FILE_BYTES) throw new ApiError(413, 'file exceeds the 5 MiB limit', 'payload_too_large');
}

function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}

/** Validate size and canonical base64 before allocating a decoded file buffer. */
export function decodeUpload(content: string): Buffer {
  if (content.length > MAX_ENCODED_BYTES) throw new ApiError(413, 'encoded file too large', 'payload_too_large');
  const invalid = () => ApiError.badRequest('file content must be canonical base64');
  if (content.length % 4 !== 0) throw invalid();
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  const size = content.length / 4 * 3 - padding;
  assertFileSize(size);
  const end = content.length - padding;
  // Linear validation avoids a repeated-group regexp on multi-megabyte strings.
  for (let i = 0; i < end; i++) if (sextet(content.charCodeAt(i)) < 0) throw invalid();
  if (padding && (sextet(content.charCodeAt(end - 1)) & (padding === 2 ? 15 : 3))) throw invalid();
  return Buffer.from(content, 'base64');
}
