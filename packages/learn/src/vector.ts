/** Dot product. Both vectors must have the same length. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Scales a vector to unit length in place (a zero vector is left as is) and returns it. */
export function normalize(v: Float32Array): Float32Array {
  const norm = Math.sqrt(dot(v, v));
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

/**
 * Encodes a unit vector as base64 int8 (one byte per dimension, value × 127). Halves the size of
 * fp16 and keeps cosine similarities within about 0.01, plenty for kNN and a linear head.
 */
export function encodeInt8(v: Float32Array): string {
  const bytes = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * 127))) & 0xff;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Decodes {@link encodeInt8} and re-normalizes. */
export function decodeInt8(text: string): Float32Array {
  const binary = atob(text);
  const v = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i);
    v[i] = (byte > 127 ? byte - 256 : byte) / 127;
  }
  return normalize(v);
}

/** Numerically stable softmax of `z`, in place. */
export function softmaxInPlace(z: Float64Array): Float64Array {
  let max = -Infinity;
  for (const x of z) if (x > max) max = x;
  let sum = 0;
  for (let i = 0; i < z.length; i++) sum += z[i] = Math.exp(z[i]! - max);
  for (let i = 0; i < z.length; i++) z[i]! /= sum;
  return z;
}
