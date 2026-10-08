// Generate or validate platform icons; no network or platform-specific tooling required.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAssets } from "./icon-core.mjs";

const root=resolve(fileURLToPath(new URL("../src-tauri/icons/", import.meta.url)));
const check=process.argv.includes("--check");
if(!check)mkdirSync(root,{recursive:true});
for(const [name,expected] of generateAssets()){
  const path=resolve(root,name);
  if(check){
    let found;
    try{found=readFileSync(path);}catch{throw new Error("Missing generated icon: "+path);}
    if(!found.equals(Buffer.from(expected)))throw new Error("Icon resource drift: "+path+"; run npm run icons:generate");
  }else writeFileSync(path,expected);
  console.log(name+": "+expected.length+" bytes "+(check?"verified":"generated"));
}
console.log(check?"Icon parity PASS: 16px–1024px orange V":"Platform icons generated");
