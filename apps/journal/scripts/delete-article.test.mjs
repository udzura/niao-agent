import assert from "node:assert/strict";
import {it} from "node:test";
import {parseOptions,deleteArticle} from "./delete-article.mjs";

const id="d4053a32-f157-4619-87f0-956038cc173f",revision="2026-11-03T00:00:00.000Z";
it("requires an explicit target and revision confirmation for the operator CLI",()=>{
  for(const args of [[],["--remote","--local","--article-id",id],["--remote","--article-id","';DELETE FROM articles;--"],["--remote","--article-id",id,"--confirm"]])
    assert.throws(()=>parseOptions(args));
  assert.deepEqual(parseOptions(["--remote","--article-id",id]),{remote:true,articleId:id,expectedUpdatedAt:undefined,confirm:false});
});
it("previews without writing, rejects stale revisions, then verifies deletion",async()=>{
  let article={id,title:"削除対象",status:"published",updatedAt:revision};const sql=[];
  const execute=async statement=>{sql.push(statement);if(statement.startsWith("INSERT")){article=null;return [];}return article ? [article] : [];};
  const options={remote:true,articleId:id};
  assert.equal((await deleteArticle(options,execute)).deleted,false);
  assert.equal(sql.length,1);
  await assert.rejects(()=>deleteArticle({...options,confirm:true,expectedUpdatedAt:"old"},execute),/Article changed/);
  assert.ok(sql.every(s=>s.startsWith("SELECT")));
  assert.deepEqual(await deleteArticle({...options,confirm:true,expectedUpdatedAt:revision},execute),{deleted:true,articleId:id});
  assert.ok(sql.some(s=>s.startsWith("INSERT INTO journal_deletions")));
  assert.match(sql.at(-1),/^SELECT/);
});
