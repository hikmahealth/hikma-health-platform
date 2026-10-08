import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import type {
  ColumnType,
  Generated,
  Selectable,
  Insertable,
  Updateable,
} from "kysely";
import db from "@/db";
import User from "./user";
import { createServerOnlyFn } from "@tanstack/react-start";

namespace Token {
  /** The `token` column holds this SHA-256 hex digest, never the raw token. */
  export const hash = (token: string): string =>
    createHash("sha256").update(token, "utf8").digest("hex");

  export type T = {
    user_id: string;
    token: string;
    expiry: Date;
  };
  export namespace Table {
    export const name = "tokens";
    export const columns = {
      user_id: "user_id",
      token: "token",
      expiry: "expiry",
    };

    export interface T {
      user_id: string;
      token: string;
      expiry: ColumnType<Date, string | undefined, never>;
    }

    export type Tokens = Selectable<T>;
    export type NewTokens = Insertable<T>;
    export type TokensUpdate = Updateable<T>;
  }

  /** None when the token is unknown or expired. */
  export const getUser = createServerOnlyFn(
    async (token: string): Promise<Option.Option<User.T>> => {
      let query = db.selectFrom(Table.name);

      query = query.where("token", "=", hash(token));
      query = query.where("expiry", ">", new Date().toISOString());

      const res = await query.select(["user_id"]).executeTakeFirst();

      return Option.match(Option.fromNullable(res), {
        onNone: () => Option.none(),
        onSome: async ({ user_id }) => {
          const user = await db
            .selectFrom(User.Table.name)
            .where("id", "=", user_id)
            .selectAll()
            .executeTakeFirst();

          return Option.fromNullable({
            ...user,
            hashed_password: "***************",
          } as unknown as User.T);
        },
      });
    },
  );

  export const invalidate = createServerOnlyFn(
    async (token: string): Promise<void> => {
      await db
        .deleteFrom(Table.name)
        .where("token", "=", hash(token))
        .execute();
    },
  );

  /** Returns the raw token; only its hash is stored. */
  export const create = createServerOnlyFn(
    async (userId: string, expiry: Date): Promise<string> => {
      const token = crypto.randomUUID();
      await db
        .insertInto(Token.Table.name)
        .values({
          user_id: userId,
          token: hash(token),
          expiry: expiry.toISOString(),
        })
        .execute();

      return token;
    },
  );
}

export default Token;
