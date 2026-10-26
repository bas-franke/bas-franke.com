import { config } from '../config.js';
import { BitvavoClient } from './client.js';

export * from './client.js';
export * from './precision.js';

/** The process-wide client. Without keys only public endpoints work (paper mode still runs on live prices). */
export const bitvavo = new BitvavoClient({
  apiKey: config.bitvavoKey,
  apiSecret: config.bitvavoSecret,
  baseUrl: config.bitvavoUrl,
  operatorId: config.bitvavoOperatorId,
});
