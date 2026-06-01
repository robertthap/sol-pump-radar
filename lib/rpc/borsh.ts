export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  remaining(): number {
    return this.buf.length - this.offset;
  }

  u8(): number {
    this.require(1);
    return this.buf.readUInt8(this.offset++);
  }

  u32(): number {
    this.require(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    this.require(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    this.require(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  pubkey(): Buffer {
    this.require(32);
    const v = this.buf.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return v;
  }

  string(): string {
    const len = this.u32();
    if (len > 1_000_000) throw new Error("borsh string too long");
    this.require(len);
    const v = this.buf.subarray(this.offset, this.offset + len).toString("utf8");
    this.offset += len;
    return v;
  }

  private require(n: number) {
    if (this.offset + n > this.buf.length) throw new Error("borsh out of bounds");
  }
}

export function safeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (v < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
  return Number(v);
}
