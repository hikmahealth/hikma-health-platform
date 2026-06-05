import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";

export const putFileServerFn = createServerFn({ method: "POST" }).handler(
  async (req) => {},
);
