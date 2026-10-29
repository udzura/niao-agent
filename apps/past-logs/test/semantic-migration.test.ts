import {env, applyD1Migrations, reset} from "cloudflare:test";
import {afterEach, expect, it} from "vitest";
import {DocumentService} from "../src/documents";
import {SemanticIndex} from "../src/semantic";
import {EmbeddingFixture, VectorFixture} from "./semantic-fixtures";
const bindings = env as any;
afterEach(async () => { await reset(); });
it("migrates an existing keyword-only archive and queues it for semantic backfill", async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS.slice(0, 1));
  const documents = new DocumentService(bindings.DB);
  const doc = await documents.upsert({source: "manual", source_id: "existing", url: "https://example.com/old",
    title: "Rubyの記録", body: "既存のRubyについての記事", created_at: "2020-01-01T00:00:00Z"});
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  const embeddings = new EmbeddingFixture(), vectors = new VectorFixture();
  const index = new SemanticIndex(bindings.DB, {AI: embeddings.ai, VECTORIZE: vectors.binding});
  expect((await index.summary()).pending).toBe(1);
  await index.reindex({}); vectors.flush();
  expect((await index.search({query: "ランタイム"}))[0].id).toBe(doc.id);
  expect((await documents.search({query: "Ruby"}))[0].id).toBe(doc.id);
  expect(await documents.get(doc.id)).toEqual(doc);
});
