import type { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";

import { Transform } from "stream";

import {
  ParsedTransactionStream,
  type ParsedTransactionStreamData,
  type ParsedTransactionStreamAllTransactionsFound,
  type ParsedTransactionStreamSignatureCount,
} from "./ParsedTransactionStream";
import { getDlmmPairs, type MeteoraDlmmPair } from "./MeteoraDlmmApi";
import { type JupiterTokenListToken } from "./JupiterTokenList";
import {
  parseMeteoraTransactions,
  type MeteoraPositionTransaction,
} from "./ParseMeteoraTransactions";
import { MeteoraPosition, invertAndFillMissingFees } from "./MeteoraPosition";
import { AsyncBatchProcessor, delay } from "./util";
import { updateOpenPosition } from "./UpdateOpenPositions";

interface MeteoraPositionStreamTransactionCount {
  type: "transactionCount";
  meteoraTransactionCount: number;
}

interface MeteoraPositionStreamPositionAndTransactions {
  type: "positionAndTransactions";
  transactions: MeteoraPositionTransaction[];
  position: MeteoraPosition;
}

interface MeteoraPositionStreamUpdatingOpenPositions {
  type: "updatingOpenPositions";
  openPositionCount: number;
}

export type MeteoraPositionStreamData =
  | ParsedTransactionStreamSignatureCount
  | ParsedTransactionStreamAllTransactionsFound
  | MeteoraPositionStreamTransactionCount
  | MeteoraPositionStreamPositionAndTransactions
  | MeteoraPositionStreamUpdatingOpenPositions;

interface MeteoraPositionStreamEvents {
  data: (data: MeteoraPositionStreamData) => void;
  error: (error: Error) => void;
  end: () => void;
}

export class MeteoraPositionStream extends Transform {
  private _pairs: Map<string, MeteoraDlmmPair> = new Map();
  private _tokenMap: Map<string, JupiterTokenListToken>;
  private _transactionStream!: ParsedTransactionStream;
  private _receivedAllTransactions = false;
  private _transactionsReceivedCount = 0;
  private _transactionsProcessedCount = 0;
  private _transactions: MeteoraPositionTransaction[] = [];
  private _processor!: AsyncBatchProcessor<
    ParsedTransactionWithMeta,
    MeteoraPositionTransaction
  >;
  private _done = false;
  private _cancelling = false;
  private _cancelled = false;
  private _pendingPositions: string[] = [];

  constructor(
    connection: Connection,
    walletAddress: string,
    tokenMap: Map<string, JupiterTokenListToken>,
    before?: string,
    until?: string,
    minDate?: Date,
  ) {
    super({ objectMode: true });
    this._tokenMap = tokenMap;
    this._init(connection, walletAddress, before, until, minDate);
  }

  cancel() {
    this._transactionStream.cancel();
    this._cancelling = true;
  }

  private async _init(
    connection: Connection,
    walletAddress: string,
    before?: string,
    until?: string,
    minDate?: Date,
  ) {
    const { pairs } = await getDlmmPairs();

    this._pairs = pairs;
    this._processor = new AsyncBatchProcessor((parsedTransactionsWithMeta) =>
      parseMeteoraTransactions(
        connection,
        this._pairs,
        this._tokenMap,
        parsedTransactionsWithMeta,
      ),
    );

    this._transactionStream = new ParsedTransactionStream(
      connection,
      walletAddress,
      before,
      until,
      minDate,
    )
      .on("data", (data) => this._parseTransactions(connection, data))
      .on("end", async () => {
        this._receivedAllTransactions = true;

        while (!this._processor.isComplete) {
          await this._processBatch(connection);
          await delay(0);
        }
      })
      .on("error", (error) => this.emit("error", error));
  }

  private async _processBatch(connection: Connection) {
    if (!this._cancelling && !this._cancelled) {
      const { inputCount, output } = await this._processor.next();

      if (inputCount > 0) {
        if (output.length > 0) {
          this._transactions = this._transactions.concat(output);
          this.push({
            type: "transactionCount",
            meteoraTransactionCount: this._transactions.length,
          });

          await Promise.all(
            output.map(async (positionTransaction) => {
              if (positionTransaction.open) {
                await this._createPosition(connection, positionTransaction);
              }
            }),
          );
        }

        this._transactionsProcessedCount += inputCount;
      }
      this._finish();
    }
  }

  private async _parseTransactions(
    connection: Connection,
    data: ParsedTransactionStreamData,
  ) {
    if (data.type != "parsedTransaction") {
      switch (data.type) {
        case "allSignaturesFound":
          this._receivedAllTransactions = true;
          break;
        case "signatureCount":
          this._transactionsReceivedCount = data.signatureCount;
          break;
      }
      this.push(data);

      return this._finish();
    }

    this._processor.addBatch(data.parsedTransactionsWithMeta);
    this._processBatch(connection);
  }

  private async _createPosition(
    connection: Connection,
    positionTransaction: MeteoraPositionTransaction,
  ) {
    this._pendingPositions.push(positionTransaction.position);
    const newPositionTransactions = invertAndFillMissingFees(
      this._transactions.filter(
        (transaction) => transaction.position == positionTransaction.position,
      ),
    );
    const newPosition = new MeteoraPosition(newPositionTransactions);

    if (newPosition.isClosed) {
      this.push({
        type: "positionAndTransactions",
        transactions: newPositionTransactions,
        position: newPosition,
      });
    } else {
      await this._updateOpenPosition(
        connection,
        newPositionTransactions,
        newPosition,
      );
    }
    this._pendingPositions.splice(
      this._pendingPositions.indexOf(positionTransaction.position),
      1,
    );
  }

  private async _updateOpenPosition(
    connection: Connection,
    transactions: MeteoraPositionTransaction[],
    position: MeteoraPosition,
  ) {
    await updateOpenPosition(connection, position);
    this.push({
      type: "positionAndTransactions",
      transactions,
      position,
    });
  }

  private async _finish() {
    if (
      this._receivedAllTransactions &&
      this._transactionsReceivedCount == this._transactionsProcessedCount &&
      !this._done
    ) {
      this._done = true;
      this.push(null);
    }
  }

  on<Event extends keyof MeteoraPositionStreamEvents>(
    event: Event,
    listener: MeteoraPositionStreamEvents[Event],
  ): this {
    return super.on(event, listener);
  }

  emit<Event extends keyof MeteoraPositionStreamEvents>(
    event: Event,
    ...args: Parameters<MeteoraPositionStreamEvents[Event]>
  ): boolean {
    return super.emit(event, ...args);
  }

  push(
    chunk: MeteoraPositionStreamData | null,
    encoding?: BufferEncoding,
  ): boolean {
    if (this._pendingPositions.length > 0) {
      return super.push(chunk, encoding);
    }
    if (this._cancelling && !this._cancelled) {
      this._cancelled = true;

      return super.push(null);
    }
    if (this._cancelled) {
      return false;
    }

    return super.push(chunk, encoding);
  }
}
