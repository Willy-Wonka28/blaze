// Polymarket CLOB client v2 — places FAK (Fill-and-Kill) taker orders.
// Uses @polymarket/clob-client-v2 SDK for order creation + signing only.
// Submits via raw fetch to avoid the SDK's error-swallowing HTTP layer.
//
// FAK = fills what's available immediately at best ask, cancels the rest.
// The price field is a ceiling (slippage protection), not a target price.
// Polymarket enforces a 1-second hold on live sports markets before matching.
// During this delay the order is pending and cannot be cancelled — but we're
// first in the queue because blaze reacts faster than manual traders.
// Supports per-user Polymarket credentials.

import { ClobClient as ClobClientV2, Side, createL2Headers } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { TickSize } from "@polymarket/clob-client-v2";
import { config } from "../../config.js";

const CLOB_HOST = config.polymarket.baseUrl;
const CHAIN_ID = 137;

interface FAKOrderParams {
  token_id: string;
  price: number;
  amount: number; // USDC amount to spend (not contract count)
  tick_size: number;
  neg_risk: boolean;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  privateKey: string;
}

function makeWalletClient(privateKey: string) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return createWalletClient({ account, chain: polygon, transport: http() });
}

export async function placeFAKOrder(params: FAKOrderParams): Promise<string> {
  const { token_id, price, amount, tick_size, neg_risk, apiKey, apiSecret, passphrase, privateKey } = params;

  const walletClient = makeWalletClient(privateKey);

  // Use SDK only for order creation + signing (no HTTP)
  const tempClient = new ClobClientV2({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer: walletClient,
  });

  const signedOrder = await tempClient.createMarketOrder(
    {
      tokenID: token_id,
      side: Side.BUY,
      amount,
      price,
    },
    {
      tickSize: tick_size.toFixed(2) as TickSize,
      negRisk: neg_risk,
    },
  );

  const body = {
    order: {
      salt: parseInt(signedOrder.salt, 10),
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      taker: signedOrder.taker,
      tokenId: signedOrder.tokenId,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
      side: signedOrder.side,
      signatureType: signedOrder.signatureType,
      timestamp: signedOrder.timestamp,
      expiration: signedOrder.expiration,
      metadata: signedOrder.metadata,
      builder: signedOrder.builder,
      signature: signedOrder.signature,
    },
    owner: apiKey,
    orderType: "FAK",
  };

  const bodyStr = JSON.stringify(body);

  const headers = await createL2Headers(
    walletClient,
    { key: apiKey, secret: apiSecret, passphrase },
    { method: "POST", requestPath: "/order", body: bodyStr },
  );

  const response = await fetch(`${CLOB_HOST}/order`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: bodyStr,
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(`CLOB API error (${response.status}): ${JSON.stringify(data)}`);
  }

  if (!data.success && data.errorMsg) {
    throw new Error(`Order rejected: ${data.errorMsg}`);
  }

  return data.orderID || `poly_${Date.now()}`;
}
