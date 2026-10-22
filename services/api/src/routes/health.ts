import type { FastifyInstance } from "fastify";
import { ROUTES } from "@lingo/core";
import type { Deps } from "../app";

export function registerHealth(app: FastifyInstance, deps: Deps) {
  app.get(ROUTES.health, async () => ({ ok: true, time: deps.now().toISOString() }));
}
