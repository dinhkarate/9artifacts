// The slice of node:buffer (nodejs_compat) used for fast, native base64.
declare module 'node:buffer' {
  export class Buffer extends Uint8Array {
    static from(data: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
    static from(data: string, encoding: 'base64' | 'base64url' | 'hex'): Buffer;
    toString(encoding: 'base64' | 'base64url' | 'hex'): string;
  }
}
