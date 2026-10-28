// Local Node/V8 measurements, not a simulation of Cloudflare Free CPU accounting.
import {build} from 'esbuild';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = resolve(import.meta.dirname,'../..');
await mkdir(resolve(root,'build'),{recursive:true});
const output = resolve(root,'build/ruby-benchmark.mjs');
await build({entryPoints:[resolve(root,'apps/ruby-runner/src/execute.ts')],outfile:output,bundle:true,format:'esm',platform:'node',plugins:[{
  name:'local-compiled-wasm',setup(build) {
    build.onLoad({filter:/\.wasm$/},async ({path})=>({loader:'js',contents:`export default new WebAssembly.Module(Uint8Array.from(Buffer.from(${JSON.stringify((await readFile(path)).toString('base64'))},'base64')));`}));
  },
}]});
const cpu = process.threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);
const ms = value => (value.user + value.system)/1000;
const loadCpu = cpu(), loadStart = performance.now();
const {executeRuby} = await import(pathToFileURL(output));
const moduleLoad = {wallMs:performance.now()-loadStart,cpuMs:ms(cpu(loadCpu))};
const snippets = [
  ['arithmetic','1 + 1'],
  ['stdout','puts "Hello from Niao!"'],
  ['sum100','(1..100).inject(0) { |s,n| s+n*n }'],
  ['sum1000','(1..1000).inject(0) { |s,n| s+n }'],
  ['fuel_exhaustion','loop {}'],
];
const percentile = (values,p) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
const workloads = [];
for (const [name,code] of snippets) {
  const samples = [];
  for (let i=0;i<31;i++) {
    const before = cpu();
    const result = await executeRuby({code});
    samples.push({cpuMs:ms(cpu(before)),status:result.ok?'ok':result.error,instructions:result.instructions,...result.timings});
  }
  const warm = samples.slice(1);
  const metrics = Object.fromEntries(['cpuMs','wasmInitMs','vmInitMs','compileMs','evalMs','serializeMs','totalMs'].map(key=>[key,{median:percentile(warm.map(x=>x[key]),.5),p95:percentile(warm.map(x=>x[key]),.95),max:Math.max(...warm.map(x=>x[key]))}]));
  workloads.push({name,first:samples[0],samples:warm.length,metrics});
}
const result = {node:process.version,platform:process.platform,arch:process.arch,cpuClock:process.threadCpuUsage?'threadCpuUsage':'processCpuUsage',moduleLoad,workloads,scope:'Local Node/V8 only. No hosted Free-plan CPU claim. Includes allocation/GC variability; RPC overhead is not included.'};
const file = resolve(root,'build/ruby-benchmark.json');
await writeFile(file,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
