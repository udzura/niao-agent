import {describe,it,expect} from 'vitest';
import {DefaultAdapter,Gemma4Adapter,modelOutputAdapter,type ModelOutputAdapter} from '../src/model-output';
function collect(chunks: string[],adapter: ModelOutputAdapter = new Gemma4Adapter()) {
  let content='',thinking='';
  for (const output of [...chunks.map(chunk=>adapter.transform(chunk)),adapter.flush()]) {
    content += output.content ?? ''; thinking += output.thinking ?? '';
  }
  return {content,thinking};
}
describe('model-specific thinking output normalization',()=>{
  const raw = '<|channel>thought\n検討します\n  改行を保持<channel|>**回答**です';
  it('separates documented channels across every possible two-chunk split',()=>{
    for (let i=0;i<=raw.length;i++) expect(collect([raw.slice(0,i),raw.slice(i)])).toEqual({content:'**回答**です',thinking:'検討します\n  改行を保持'});
    expect(collect([...raw])).toEqual({content:'**回答**です',thinking:'検討します\n  改行を保持'});
  });
  it('handles empty thinking, repeated transitions, CRLF and plain text',()=>{
    expect(collect(['<|channel>thought\n<channel|>answer'])).toEqual({content:'answer',thinking:''});
    expect(collect(['before<|channel>thought\na<channel|>middle<|channel>thought\nb<channel|>after'])).toEqual({content:'beforemiddleafter',thinking:'ab'});
    expect(collect([...'<|channel>thought\r\n日本語<channel|>回答'])).toEqual({content:'回答',thinking:'日本語'});
    expect(collect(['thought is a normal word. 1 < 2\ntext'])).toEqual({content:'thought is a normal word. 1 < 2\ntext',thinking:''});
  });
  it('withholds incomplete/malformed markers and never promotes unfinished thinking to final content',()=>{
    expect(collect(['answer<|chan'])).toEqual({content:'answer',thinking:''});
    expect(collect(['<|channel>thought\nnot yet final<chan'])).toEqual({content:'',thinking:'not yet final'});
    expect(collect(['<|channel>unknown\nprivate<channel|>final'])).toEqual({content:'final',thinking:'private'});
    expect(collect(['<|channel!>thought\nprivate<channel|>final'])).toEqual({content:'final',thinking:'private'});
    const adapter=new Gemma4Adapter();
    expect(adapter.transform('<|channel>')).toMatchObject({thinkingActive:true});
    expect(adapter.flush()).toMatchObject({thinkingActive:false});
  });
  it('streams content without waiting for the full generation and defaults pass through exactly',()=>{
    const adapter=new Gemma4Adapter();
    expect(adapter.transform('answer now')).toEqual({content:'answer now'});
    expect(collect([raw],new DefaultAdapter())).toEqual({content:raw,thinking:''});
    expect(modelOutputAdapter('@cf/zai-org/glm-4.7-flash')).toBeInstanceOf(DefaultAdapter);
    expect(modelOutputAdapter('@cf/google/gemma-4-26b-a4b-it')).toBeInstanceOf(Gemma4Adapter);
  });
});
