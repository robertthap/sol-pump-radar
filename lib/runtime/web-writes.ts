import "server-only";
/**
 * Single import path for allowlisted Postgres mutations from Next API routes.
 * Do not call getDb() for writes in app/api — use executeWebMutation here.
 */
export { executeWebMutation, WebWriteOp, type WebWriteOpType } from "@spr/db";
