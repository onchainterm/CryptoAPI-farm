import type {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction
} from "@solana/web3.js";
import { publicKeyToString } from "./keys.js";

type JsonRecord = Record<string, unknown>;
type SolanaInstruction = ParsedInstruction | PartiallyDecodedInstruction;

export interface NativeTransfer {
  instructionIndex: number;
  innerIndex: number | null;
  transferOrder: number;
  fromAddress: string | null;
  toAddress: string | null;
  lamports: string;
  sol: string;
}

export interface TokenTransfer {
  instructionIndex: number;
  innerIndex: number | null;
  transferOrder: number;
  mint: string | null;
  sourceAccount: string | null;
  destinationAccount: string | null;
  sourceOwner: string | null;
  destinationOwner: string | null;
  authority: string | null;
  amountRaw: string | null;
  amount: string | null;
  decimals: number | null;
  tokenProgram: string | null;
  instructionType: string;
}

export interface NftEvent {
  instructionIndex: number;
  innerIndex: number | null;
  transferOrder: number;
  mint: string | null;
  owner: string | null;
  fromOwner: string | null;
  toOwner: string | null;
  eventType: "mint" | "transfer" | "burn" | "unknown";
  metadata: JsonRecord;
}

export interface ProgramEvent {
  instructionIndex: number;
  innerIndex: number | null;
  programId: string;
  programName: string | null;
  instructionType: string;
  parsed: JsonRecord | null;
  logs: string[];
}

export interface BalanceChange {
  accountIndex: number;
  accountAddress: string;
  preLamports: string;
  postLamports: string;
  deltaLamports: string;
}

export interface TokenBalanceSnapshot {
  side: "pre" | "post";
  accountIndex: number;
  accountAddress: string | null;
  mint: string;
  owner: string | null;
  amountRaw: string;
  uiAmount: string | null;
  decimals: number;
}

export interface ParsedSolanaActivity {
  accountKeys: string[];
  nativeTransfers: NativeTransfer[];
  tokenTransfers: TokenTransfer[];
  nftEvents: NftEvent[];
  programEvents: ProgramEvent[];
  balanceChanges: BalanceChange[];
  tokenBalances: TokenBalanceSnapshot[];
}

interface FlatInstruction {
  instruction: SolanaInstruction;
  instructionIndex: number;
  innerIndex: number | null;
}

interface TokenBalanceLookup {
  accountAddress: string | null;
  mint: string;
  owner: string | null;
  amountRaw: string;
  decimals: number;
}

const TOKEN_PROGRAM_NAMES = new Set(["spl-token", "spl-token-2022"]);
const TOKEN_TRANSFER_TYPES = new Set([
  "transfer",
  "transferChecked",
  "mintTo",
  "mintToChecked",
  "burn",
  "burnChecked"
]);

function isParsedInstruction(instruction: SolanaInstruction): instruction is ParsedInstruction {
  return "parsed" in instruction;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringField(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return null;
}

function numberField(record: JsonRecord | null, key: string): number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rawToDecimalString(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;

  if (decimals <= 0) return `${negative ? "-" : ""}${digits}`;

  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function getAccountKeys(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.accountKeys.map((key) => publicKeyToString(key));
}

function flattenInstructions(tx: ParsedTransactionWithMeta): FlatInstruction[] {
  const flattened: FlatInstruction[] = tx.transaction.message.instructions.map((instruction, index) => ({
    instruction,
    instructionIndex: index,
    innerIndex: null
  }));

  for (const inner of tx.meta?.innerInstructions ?? []) {
    inner.instructions.forEach((instruction, innerIndex) => {
      flattened.push({
        instruction,
        instructionIndex: inner.index,
        innerIndex
      });
    });
  }

  return flattened;
}

function buildTokenBalanceLookup(tx: ParsedTransactionWithMeta, accountKeys: string[]): Map<string, TokenBalanceLookup> {
  const lookup = new Map<string, TokenBalanceLookup>();
  const balances = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])];

  for (const balance of balances) {
    const accountAddress = accountKeys[balance.accountIndex] ?? null;
    if (!accountAddress) continue;

    lookup.set(accountAddress, {
      accountAddress,
      mint: balance.mint,
      owner: balance.owner ?? null,
      amountRaw: balance.uiTokenAmount.amount,
      decimals: balance.uiTokenAmount.decimals
    });
  }

  return lookup;
}

function parseNativeTransfer(flat: FlatInstruction, transferOrder: number): NativeTransfer | null {
  const { instruction } = flat;
  if (!isParsedInstruction(instruction)) return null;
  if (instruction.program !== "system") return null;

  const parsed = asRecord(instruction.parsed);
  const type = stringField(parsed, "type");
  if (type !== "transfer" && type !== "transferWithSeed") return null;

  const info = asRecord(parsed?.info);
  const lamports = stringField(info, "lamports");
  if (!lamports) return null;

  return {
    instructionIndex: flat.instructionIndex,
    innerIndex: flat.innerIndex,
    transferOrder,
    fromAddress: stringField(info, "source"),
    toAddress: stringField(info, "destination"),
    lamports,
    sol: rawToDecimalString(lamports, 9)
  };
}

function parseTokenTransfer(
  flat: FlatInstruction,
  transferOrder: number,
  tokenBalanceLookup: Map<string, TokenBalanceLookup>
): TokenTransfer | null {
  const { instruction } = flat;
  if (!isParsedInstruction(instruction)) return null;
  if (!TOKEN_PROGRAM_NAMES.has(instruction.program)) return null;

  const parsed = asRecord(instruction.parsed);
  const type = stringField(parsed, "type");
  if (!type || !TOKEN_TRANSFER_TYPES.has(type)) return null;

  const info = asRecord(parsed?.info);
  const tokenAmount = asRecord(info?.tokenAmount);
  const sourceAccount = stringField(info, "source") ?? stringField(info, "account");
  const destinationAccount = stringField(info, "destination");
  const sourceBalance = sourceAccount ? tokenBalanceLookup.get(sourceAccount) : undefined;
  const destinationBalance = destinationAccount ? tokenBalanceLookup.get(destinationAccount) : undefined;
  const amountRaw = stringField(tokenAmount, "amount") ?? stringField(info, "amount");
  const decimals = numberField(tokenAmount, "decimals") ?? sourceBalance?.decimals ?? destinationBalance?.decimals ?? null;
  const mint = stringField(info, "mint") ?? sourceBalance?.mint ?? destinationBalance?.mint ?? null;
  const amount =
    amountRaw && decimals !== null
      ? rawToDecimalString(amountRaw, decimals)
      : stringField(tokenAmount, "uiAmountString");

  return {
    instructionIndex: flat.instructionIndex,
    innerIndex: flat.innerIndex,
    transferOrder,
    mint,
    sourceAccount,
    destinationAccount,
    sourceOwner: sourceBalance?.owner ?? stringField(info, "owner"),
    destinationOwner: destinationBalance?.owner ?? null,
    authority: stringField(info, "authority") ?? stringField(info, "multisigAuthority"),
    amountRaw,
    amount,
    decimals,
    tokenProgram: publicKeyToString(instruction.programId),
    instructionType: type
  };
}

function tokenTransferToNftEvent(transfer: TokenTransfer): NftEvent | null {
  if (transfer.decimals !== 0 || transfer.amountRaw !== "1") return null;

  let eventType: NftEvent["eventType"] = "unknown";
  if (transfer.instructionType === "transfer" || transfer.instructionType === "transferChecked") {
    eventType = "transfer";
  } else if (transfer.instructionType === "mintTo" || transfer.instructionType === "mintToChecked") {
    eventType = "mint";
  } else if (transfer.instructionType === "burn" || transfer.instructionType === "burnChecked") {
    eventType = "burn";
  }

  return {
    instructionIndex: transfer.instructionIndex,
    innerIndex: transfer.innerIndex,
    transferOrder: transfer.transferOrder,
    mint: transfer.mint,
    owner: transfer.destinationOwner ?? transfer.sourceOwner,
    fromOwner: transfer.sourceOwner,
    toOwner: transfer.destinationOwner,
    eventType,
    metadata: {
      sourceAccount: transfer.sourceAccount,
      destinationAccount: transfer.destinationAccount,
      authority: transfer.authority,
      tokenProgram: transfer.tokenProgram
    }
  };
}

function parseProgramEvent(flat: FlatInstruction, logs: string[]): ProgramEvent {
  const { instruction } = flat;
  const programId = publicKeyToString(instruction.programId);

  if (!isParsedInstruction(instruction)) {
    return {
      instructionIndex: flat.instructionIndex,
      innerIndex: flat.innerIndex,
      programId,
      programName: null,
      instructionType: "partially_decoded",
      parsed: {
        accounts: instruction.accounts.map((account) => publicKeyToString(account)),
        data: instruction.data
      },
      logs
    };
  }

  const parsed = asRecord(instruction.parsed);
  const type = stringField(parsed, "type") ?? "parsed";

  return {
    instructionIndex: flat.instructionIndex,
    innerIndex: flat.innerIndex,
    programId,
    programName: instruction.program,
    instructionType: type,
    parsed,
    logs
  };
}

function parseBalanceChanges(tx: ParsedTransactionWithMeta, accountKeys: string[]): BalanceChange[] {
  const preBalances = tx.meta?.preBalances ?? [];
  const postBalances = tx.meta?.postBalances ?? [];
  const maxLength = Math.max(preBalances.length, postBalances.length);
  const changes: BalanceChange[] = [];

  for (let accountIndex = 0; accountIndex < maxLength; accountIndex += 1) {
    const pre = BigInt(preBalances[accountIndex] ?? 0);
    const post = BigInt(postBalances[accountIndex] ?? 0);
    if (pre === post) continue;

    const accountAddress = accountKeys[accountIndex];
    if (!accountAddress) continue;

    changes.push({
      accountIndex,
      accountAddress,
      preLamports: pre.toString(),
      postLamports: post.toString(),
      deltaLamports: (post - pre).toString()
    });
  }

  return changes;
}

function parseTokenBalances(tx: ParsedTransactionWithMeta, accountKeys: string[]): TokenBalanceSnapshot[] {
  const snapshots: TokenBalanceSnapshot[] = [];
  const collect = (side: "pre" | "post", balances: NonNullable<typeof tx.meta>["preTokenBalances"]): void => {
    for (const balance of balances ?? []) {
      snapshots.push({
        side,
        accountIndex: balance.accountIndex,
        accountAddress: accountKeys[balance.accountIndex] ?? null,
        mint: balance.mint,
        owner: balance.owner ?? null,
        amountRaw: balance.uiTokenAmount.amount,
        uiAmount: rawToDecimalString(balance.uiTokenAmount.amount, balance.uiTokenAmount.decimals),
        decimals: balance.uiTokenAmount.decimals
      });
    }
  };

  collect("pre", tx.meta?.preTokenBalances);
  collect("post", tx.meta?.postTokenBalances);

  return snapshots;
}

export function parseSolanaTransaction(tx: ParsedTransactionWithMeta): ParsedSolanaActivity {
  const accountKeys = getAccountKeys(tx);
  const flatInstructions = flattenInstructions(tx);
  const tokenBalanceLookup = buildTokenBalanceLookup(tx, accountKeys);
  const logs = tx.meta?.logMessages ?? [];
  const nativeTransfers: NativeTransfer[] = [];
  const tokenTransfers: TokenTransfer[] = [];
  const nftEvents: NftEvent[] = [];
  const programEvents: ProgramEvent[] = [];
  let nativeTransferOrder = 0;
  let tokenTransferOrder = 0;

  for (const flat of flatInstructions) {
    const nativeTransfer = parseNativeTransfer(flat, nativeTransferOrder);
    if (nativeTransfer) {
      nativeTransfers.push(nativeTransfer);
      nativeTransferOrder += 1;
    }

    const tokenTransfer = parseTokenTransfer(flat, tokenTransferOrder, tokenBalanceLookup);
    if (tokenTransfer) {
      tokenTransfers.push(tokenTransfer);
      const nftEvent = tokenTransferToNftEvent(tokenTransfer);
      if (nftEvent) nftEvents.push(nftEvent);
      tokenTransferOrder += 1;
    }

    programEvents.push(parseProgramEvent(flat, logs));
  }

  return {
    accountKeys,
    nativeTransfers,
    tokenTransfers,
    nftEvents,
    programEvents,
    balanceChanges: parseBalanceChanges(tx, accountKeys),
    tokenBalances: parseTokenBalances(tx, accountKeys)
  };
}
