/**
 * Normalizes the binary payloads third-party generators hand back.
 *
 * `html-to-docx` picks its return type from what the runtime exposes: a Node `Buffer`
 * on older versions, an `ArrayBuffer`, or — on Node 18+, where `Blob` is a global — a
 * `Blob`. Only `Blob` needs an await, so callers cannot simply cast.
 */
export async function toNodeBuffer(value: Buffer | ArrayBuffer | Blob): Promise<Buffer> {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return Buffer.from(await value.arrayBuffer());
  }
  throw new Error(`Unsupported binary payload type: ${Object.prototype.toString.call(value)}`);
}
