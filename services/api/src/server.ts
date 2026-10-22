import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { createAuthProviders } from "./routes/auth";
import { createAppStoreVerifier } from "./routes/billing";
import { createSpeechScorer } from "./routes/speech";
import { createLlmClient } from "./routes/tutor";

const config = loadConfig();
const db = await createDb(config);
const app = await buildApp({
  db,
  config,
  now: () => new Date(),
  ...createAuthProviders(config),
  appStore: createAppStoreVerifier(config),
  llm: createLlmClient(config),
  speech: createSpeechScorer(config),
});
await app.listen({ port: config.port, host: "0.0.0.0" });
