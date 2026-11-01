import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const version=process.argv[2] ?? JSON.parse(await readFile(new URL('version.json',root),'utf8')).version;
if(!/^\d+\.\d+\.\d{8}$/.test(version))throw Error('Use MAJOR.MINOR.YYYYMMDD, e.g. 0.1.20261101');
const date=version.split('.')[2];
const iso=`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
if(!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0,10)!==iso)throw Error('Invalid release date');
const projects=['apps/macos/Niao.xcodeproj/project.pbxproj','apps/ios/Niao.xcodeproj/project.pbxproj'];
const updates=await Promise.all(projects.map(async path=>{
 const file=new URL(path,root),text=await readFile(file,'utf8');
 if((text.match(/MARKETING_VERSION = [^;]+;/g)??[]).length!==2)throw Error(`Unexpected version settings: ${path}`);
 return {file,text:text.replace(/MARKETING_VERSION = [^;]+;/g,`MARKETING_VERSION = ${version};`)};
}));
await writeFile(new URL('version.json',root),JSON.stringify({version},null,2)+'\n');
for(const update of updates)await writeFile(update.file,update.text);
console.log(`Niao ${version}: server, macOS and iOS version sources synchronized`);
