import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Minimal data-access contract used by the Creative Orchestrator. Production
 * uses the signed-in user's Supabase client (RLS applies to every call);
 * integration tests use a pg implementation that runs as the `authenticated`
 * role with the same RLS. Only plain column lists (no embeds) so both
 * implementations behave identically.
 */
export class DbError extends Error {
  constructor(public code: string | undefined, message: string) {
    super(message);
    this.name = "DbError";
  }
}

export interface SelectOptions {
  columns: string;
  eq?: Record<string, unknown>;
  in?: Record<string, unknown[]>;
  order?: { column: string; ascending: boolean };
  limit?: number;
}

export interface CreativeDb {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
  select<T = Record<string, unknown>>(table: string, opts: SelectOptions): Promise<T[]>;
  insert<T = Record<string, unknown>>(table: string, rows: Record<string, unknown>[], returning?: string): Promise<T[]>;
  update(table: string, values: Record<string, unknown>, eq: Record<string, unknown>): Promise<number>;
}

export function supabaseCreativeDb(client: SupabaseClient): CreativeDb {
  return {
    async rpc(fn, args) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new DbError(error.code, error.message);
      return data as never;
    },
    async select(table, opts) {
      let q = client.from(table).select(opts.columns);
      for (const [k, v] of Object.entries(opts.eq ?? {})) q = q.eq(k, v as never);
      for (const [k, v] of Object.entries(opts.in ?? {})) q = q.in(k, v as never[]);
      if (opts.order) q = q.order(opts.order.column, { ascending: opts.order.ascending });
      if (opts.limit) q = q.limit(opts.limit);
      const { data, error } = await q;
      if (error) throw new DbError(error.code, error.message);
      return (data ?? []) as never[];
    },
    async insert(table, rows, returning = "id") {
      const { data, error } = await client.from(table).insert(rows).select(returning);
      if (error) throw new DbError(error.code, error.message);
      return (data ?? []) as never[];
    },
    async update(table, values, eq) {
      let q = client.from(table).update(values);
      for (const [k, v] of Object.entries(eq)) q = q.eq(k, v as never);
      const { data, error } = await q.select("id");
      if (error) throw new DbError(error.code, error.message);
      return (data ?? []).length;
    },
  };
}
