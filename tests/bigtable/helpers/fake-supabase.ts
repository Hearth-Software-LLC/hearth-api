import { vi } from "vitest";

// A chainable stand-in for the supabase-js query builder. Every query is recorded as a call
// (table, operation, payload, filters, terminal) and answered by the test's `respond` function,
// so a test states only the rows it cares about and asserts on what the route wrote.

export type QueryOperation = "select" | "insert" | "update" | "upsert" | "delete";

export type QueryCall = {
  table: string;
  op: QueryOperation;
  columns: string | null;
  payload: unknown;
  options: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
  returning: string | null;
  terminal: "single" | "maybeSingle" | "then";
};

export type QueryResult = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };

export type RpcCall = { fn: string; args: Record<string, unknown> };

const FILTER_METHODS = [
  "eq", "neq", "in", "is", "or", "gte", "lte", "gt", "lt", "order", "limit", "range", "filter",
  "contains", "ilike", "like", "not", "match",
];

export function createFakeSupabase(
  respond: (call: QueryCall) => QueryResult | undefined,
  respondRpc: (call: RpcCall) => QueryResult | undefined = () => ({ data: null, error: null })
) {
  const calls: QueryCall[] = [];
  const rpcCalls: RpcCall[] = [];

  function builder(table: string) {
    const call: QueryCall = {
      table,
      op: "select",
      columns: null,
      payload: undefined,
      options: undefined,
      filters: [],
      returning: null,
      terminal: "then",
    };
    let started = false;

    const run = (terminal: QueryCall["terminal"]) => {
      call.terminal = terminal;
      calls.push(call);
      const result = respond(call) ?? {};
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null });
    };

    const chain: Record<string, unknown> = {};
    const start = (op: QueryOperation) => (first?: unknown, options?: unknown) => {
      if (!started) {
        started = true;
        call.op = op;
        if (op === "select") {
          call.columns = typeof first === "string" ? first : "*";
        } else {
          call.payload = first;
        }
        call.options = options;
      } else if (op === "select") {
        // .insert(...).select("id") style
        call.returning = typeof first === "string" ? first : "*";
      }
      return chain;
    };
    chain.select = start("select");
    chain.insert = start("insert");
    chain.update = start("update");
    chain.upsert = start("upsert");
    chain.delete = start("delete");
    for (const method of FILTER_METHODS) {
      chain[method] = (...args: unknown[]) => {
        call.filters.push({ method, args });
        return chain;
      };
    }
    chain.single = () => run("single");
    chain.maybeSingle = () => run("maybeSingle");
    chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      run("then").then(resolve, reject);
    return chain;
  }

  const from = vi.fn((table: string) => builder(table));
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    const call = { fn, args };
    rpcCalls.push(call);
    const result = respondRpc(call) ?? {};
    return { data: result.data ?? null, error: result.error ?? null };
  });

  return {
    client: { from, rpc },
    calls,
    rpcCalls,
    /** Calls to one table, optionally of one operation. */
    callsTo(table: string, op?: QueryOperation) {
      return calls.filter((call) => call.table === table && (!op || call.op === op));
    },
  };
}

/** The value of the first `.eq(column, value)` filter on a call, if any. */
export function eqValue(call: QueryCall, column: string): unknown {
  return call.filters.find((filter) => filter.method === "eq" && filter.args[0] === column)?.args[1];
}

export function hasFilter(call: QueryCall, method: string, column?: string): boolean {
  return call.filters.some((filter) => filter.method === method && (column === undefined || filter.args[0] === column));
}
