// Node stand-in for the `cloudflare:workers` runtime module. workers-oauth-provider only uses
// WorkerEntrypoint for `instanceof` checks; this app passes plain fetch handlers.
export class WorkerEntrypoint {}
