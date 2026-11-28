import { DbError, type CreativeDb, type SelectOptions } from "@/server/creative/db";
import { asUser, type Q, type TestUser } from "./helpers";

/**
 * CreativeDb implementation over pg that runs every call as the
 * `authenticated` role with the user's JWT claims — the same RLS the
 * production Supabase client is subject to.
 */
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier ${s}`);
  return s;
};

function param(v: unknown, mode: "rpc" | "insert"): unknown {
  if (Array.isArray(v)) {
    if (v.length === 0) return mode === "rpc" ? JSON.stringify(v) : "{}";
    return v.every((x) => typeof x === "string" || typeof x === "number") ? v : JSON.stringify(v);
  }
  if (v !== null && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message: string };
    throw new DbError(err.code, err.message);
  }
}

export function pgCreativeDb(user: TestUser): CreativeDb {
  const run = <T>(f: (q: Q) => Promise<T>) => wrap(() => asUser(user, f));
  return {
    rpc: (fn, args) =>
      run(async (q) => {
        const keys = Object.keys(args);
        const sql = `select public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")}) as result`;
        const { rows } = await q(sql, keys.map((k) => param(args[k], "rpc")));
        return rows[0]?.result;
      }),
    select: (table, opts: SelectOptions) =>
      run(async (q) => {
        const where: string[] = [];
        const values: unknown[] = [];
        for (const [k, v] of Object.entries(opts.eq ?? {})) {
          if (v === null) where.push(`${ident(k)} is null`);
          else {
            values.push(v);
            where.push(`${ident(k)} = $${values.length}`);
          }
        }
        for (const [k, v] of Object.entries(opts.in ?? {})) {
          values.push(v);
          where.push(`${ident(k)} = any($${values.length})`);
        }
        const cols = opts.columns.split(",").map((c) => ident(c.trim())).join(", ");
        const order = opts.order ? ` order by ${ident(opts.order.column)} ${opts.order.ascending ? "asc" : "desc"}` : "";
        const limit = opts.limit ? ` limit ${Number(opts.limit)}` : "";
        const sql = `select ${cols} from public.${ident(table)}${where.length ? ` where ${where.join(" and ")}` : ""}${order}${limit}`;
        const { rows } = await q(sql, values);
        return rows;
      }),
    insert: (table, rows, returning = "id") =>
      run(async (q) => {
        const out = [];
        for (const row of rows) {
          const keys = Object.keys(row);
          const ret = returning.split(",").map((c) => ident(c.trim())).join(", ");
          const { rows: r } = await q(
            `insert into public.${ident(table)} (${keys.map(ident).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning ${ret}`,
            keys.map((k) => param(row[k], "insert")),
          );
          out.push(r[0]);
        }
        return out;
      }),
    update: (table, values, eq) =>
      run(async (q) => {
        const vk = Object.keys(values);
        const ek = Object.keys(eq);
        const { rowCount } = await q(
          `update public.${ident(table)} set ${vk.map((k, i) => `${ident(k)} = $${i + 1}`).join(", ")} where ${ek.map((k, i) => `${ident(k)} = $${vk.length + i + 1}`).join(" and ")}`,
          [...vk.map((k) => param(values[k], "insert")), ...ek.map((k) => eq[k])],
        );
        return rowCount ?? 0;
      }),
  };
}
