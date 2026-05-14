import { PublicKey } from "@solana/web3.js";

export function validatePublicKey(address: string): string {
  try {
    return new PublicKey(address).toBase58();
  } catch {
    throw new Error(`Invalid Solana public key: ${address}`);
  }
}

export function publicKeyToString(value: unknown): string {
  if (typeof value === "string") return value;

  if (value && typeof value === "object") {
    const maybe = value as {
      pubkey?: { toBase58?: () => string; toString?: () => string };
      toBase58?: () => string;
      toString?: () => string;
    };

    if (maybe.pubkey?.toBase58) return maybe.pubkey.toBase58();
    if (maybe.pubkey?.toString) return maybe.pubkey.toString();
    if (maybe.toBase58) return maybe.toBase58();
    if (maybe.toString) return maybe.toString();
  }

  return String(value);
}
