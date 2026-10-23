export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Bearer token for /api/* (Worker secret; locally via .dev.vars). */
  API_TOKEN?: string;
};
