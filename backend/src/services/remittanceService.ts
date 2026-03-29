import { query } from "../db/connection.js";
import { AppError } from "../errors/AppError.js";
import logger from "../utils/logger.js";
import * as StellarSdk from "@stellar/js-sdk";
import crypto from "crypto";

export interface CreateRemittancePayload {
  recipientAddress: string;
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  memo?: string;
  senderAddress: string;
}

export interface Remittance {
  id: string;
  senderId: string;
  recipientAddress: string;
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  memo?: string;
  status: "pending" | "processing" | "completed" | "failed";
  transactionHash?: string;
  xdr?: string;
  createdAt: string;
  updatedAt: string;
}

const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET_NETWORK_PASSPHRASE;
const SERVER_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org:443";

export const remittanceService = {
  /**
   * Create a new remittance record and generate XDR
   */
  async createRemittance(payload: CreateRemittancePayload): Promise<Remittance> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      // Validate recipient address format
      if (!StellarSdk.StrKey.isValidEd25519PublicKey(payload.recipientAddress)) {
        throw AppError.badRequest("Invalid Stellar recipient address");
      }

      if (!StellarSdk.StrKey.isValidEd25519PublicKey(payload.senderAddress)) {
        throw AppError.badRequest("Invalid Stellar sender address");
      }

      // Get Stellar server for XDR building
      const server = new StellarSdk.SorobanRpc.Server(SERVER_URL, { allowHttp: true });
      const sourceAccount = await server.getAccount(payload.senderAddress);

      // Build transaction
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addMemo(StellarSdk.Memo.text(payload.memo || "RemitLend Transfer"))
        .addOperation(
          StellarSdk.Operation.payment({
            destination: payload.recipientAddress,
            asset: new StellarSdk.Asset(payload.fromCurrency, process.env.STELLAR_CONTRACT_ID || ""),
            amount: payload.amount.toString(),
          })
        )
        .setNetworkPassphrase(NETWORK_PASSPHRASE)
        .setTimeout(180)
        .build();

      const xdr = transaction.toXDR();

      // Store in database
      const result = await query(
        `INSERT INTO remittances 
         (id, sender_id, recipient_address, amount, from_currency, to_currency, memo, status, xdr, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          id,
          payload.senderAddress,
          payload.recipientAddress,
          payload.amount,
          payload.fromCurrency,
          payload.toCurrency,
          payload.memo || null,
          "pending",
          xdr,
          now,
          now,
        ]
      );

      if (!result.rows[0]) {
        throw AppError.internal("Failed to create remittance record");
      }

      const record = result.rows[0];

      return {
        id: record.id,
        senderId: record.sender_id,
        recipientAddress: record.recipient_address,
        amount: parseFloat(record.amount),
        fromCurrency: record.from_currency,
        toCurrency: record.to_currency,
        memo: record.memo,
        status: record.status,
        transactionHash: record.transaction_hash,
        xdr: record.xdr,
        createdAt: record.created_at.toISOString(),
        updatedAt: record.updated_at.toISOString(),
      };
    } catch (error) {
      logger.error("Error creating remittance:", error);

      if (error instanceof AppError) {
        throw error;
      }

      throw AppError.internal("Failed to create remittance");
    }
  },

  /**
   * Get remittances for a user
   */
  async getRemittances(
    userId: string,
    limit: number = 20,
    offset: number = 0,
    status?: string
  ): Promise<{ remittances: Remittance[]; total: number }> {
    try {
      let whereClause = "sender_id = $1";
      let params: (string | number)[] = [userId];

      if (status && status !== "all") {
        whereClause += " AND status = $2";
        params.push(status);
      }

      const result = await query(
        `SELECT * FROM remittances 
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );

      const countResult = await query(
        `SELECT COUNT(*) as total FROM remittances WHERE ${whereClause}`,
        params
      );

      const remittances = result.rows.map((r) => ({
        id: r.id,
        senderId: r.sender_id,
        recipientAddress: r.recipient_address,
        amount: parseFloat(r.amount),
        fromCurrency: r.from_currency,
        toCurrency: r.to_currency,
        memo: r.memo,
        status: r.status,
        transactionHash: r.transaction_hash,
        xdr: r.xdr,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      }));

      return {
        remittances,
        total: parseInt(countResult.rows[0]?.total || "0", 10),
      };
    } catch (error) {
      logger.error("Error fetching remittances:", error);
      throw AppError.internal("Failed to fetch remittances");
    }
  },

  /**
   * Get a single remittance by ID
   */
  async getRemittance(id: string): Promise<Remittance> {
    try {
      const result = await query("SELECT * FROM remittances WHERE id = $1", [id]);

      if (!result.rows[0]) {
        throw AppError.notFound("Remittance not found");
      }

      const r = result.rows[0];

      return {
        id: r.id,
        senderId: r.sender_id,
        recipientAddress: r.recipient_address,
        amount: parseFloat(r.amount),
        fromCurrency: r.from_currency,
        toCurrency: r.to_currency,
        memo: r.memo,
        status: r.status,
        transactionHash: r.transaction_hash,
        xdr: r.xdr,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    } catch (error) {
      logger.error("Error fetching remittance:", error);

      if (error instanceof AppError) {
        throw error;
      }

      throw AppError.internal("Failed to fetch remittance");
    }
  },

  /**
   * Update remittance status after transaction is submitted
   */
  async updateRemittanceStatus(
    id: string,
    status: "processing" | "completed" | "failed",
    transactionHash?: string,
    error?: string
  ): Promise<Remittance> {
    try {
      const updateData: Record<string, unknown> = {
        status,
        updated_at: new Date().toISOString(),
      };

      if (transactionHash) {
        updateData.transaction_hash = transactionHash;
      }

      if (error) {
        updateData.error_message = error;
      }

      const result = await query(
        `UPDATE remittances 
         SET status = $1, transaction_hash = $2, updated_at = $3
         WHERE id = $4
         RETURNING *`,
        [status, transactionHash || null, updateData.updated_at, id]
      );

      if (!result.rows[0]) {
        throw AppError.notFound("Remittance not found");
      }

      const r = result.rows[0];

      return {
        id: r.id,
        senderId: r.sender_id,
        recipientAddress: r.recipient_address,
        amount: parseFloat(r.amount),
        fromCurrency: r.from_currency,
        toCurrency: r.to_currency,
        memo: r.memo,
        status: r.status,
        transactionHash: r.transaction_hash,
        xdr: r.xdr,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    } catch (error) {
      logger.error("Error updating remittance:", error);

      if (error instanceof AppError) {
        throw error;
      }

      throw AppError.internal("Failed to update remittance");
    }
  },
};
