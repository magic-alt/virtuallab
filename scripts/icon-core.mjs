// Single source of truth for the orange-V app icon.
// Deterministic, dependency-free raster, PNG, Windows ICO, macOS ICNS generation.
const V=[[270,300],[390,300],[512,664],[634,300],[754,300],[572,776],[452,776]];
const BG=[9,12,18],ORANGE=[255,137,17];
const LENGTH_BASE=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258],LENGTH_EXTRA=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DISTANCE_BASE=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577],DISTANCE_EXTRA=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

function cat(parts){const size=parts.reduce((s,a)=>s+a.length,0),out=new Uint8Array(size);let p=0;for(const a of parts){out.set(a,p);p+=a.length;}return out;}

function ascii(str){return Uint8Array.from([...str].map(c=>c.charCodeAt(0)));}

function w32be(n){return Uint8Array.of((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255);}

function w32le(n){return Uint8Array.of(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255);}

function w16le(n){return Uint8Array.of(n&255,(n>>>8)&255);}

function put(out,at,seq){out.set(seq,at);}

function insideRounded(x,y,left,top,width,height,r){const px=Math.max(left+r,Math.min(left+width-r,x)),py=Math.max(top+r,Math.min(top+height-r,y)),dx=x-px,dy=y-py;return dx*dx+dy*dy<=r*r;}

function inPoly(x,y){let result=false;for(let i=0,j=V.length-1;i<V.length;j=i++){const [xi,yi]=V[i],[xj,yj]=V[j];if(((yi>y)!==(yj>y)) && x<(xj-xi)*(y-yi)/(yj-yi)+xi)result=!result;}return result;}

function colorAt(x,y){if(!insideRounded(x,y,64,64,896,896,202))return 0;if(!insideRounded(x,y,99,99,826,826,170)||inPoly(x,y))return 2;return 1;}

function raster(size){const out=new Uint8Array(size*size*4),n=size>=1024?2:4,samples=n*n,step=1024/size;for(let y=0;y<size;y++)for(let x=0;x<size;x++){let black=0,fg=0;for(let py=0;py<n;py++)for(let px=0;px<n;px++){const c=colorAt((x+(px+.5)/n)*step,(y+(py+.5)/n)*step);if(c===1)black++;else if(c===2)fg++;}const sum=black+fg,off=(y*size+x)*4;if(sum){out[off]=Math.round((BG[0]*black+ORANGE[0]*fg)/sum);out[off+1]=Math.round((BG[1]*black+ORANGE[1]*fg)/sum);out[off+2]=Math.round((BG[2]*black+ORANGE[2]*fg)/sum);out[off+3]=Math.round(255*sum/samples);}}return out;}

function reverseBits(v,count){let r=0;for(let i=0;i<count;i++){r=(r<<1)|(v&1);v>>>=1;}return r;}

function fixedDeflate(input){const out=[];let bitAcc=0,bitCount=0;function putBits(v,n){bitAcc|=v<<bitCount;bitCount+=n;while(bitCount>=8){out.push(bitAcc&255);bitAcc>>>=8;bitCount-=8;}}function symbol(v){let code,count;if(v<=143){code=48+v;count=8;}else if(v<=255){code=400+v-144;count=9;}else if(v<=279){code=v-256;count=7;}else{code=192+v-280;count=8;}putBits(reverseBits(code,count),count);}function match(len,dist){let i=0;while(i<28&&len>=LENGTH_BASE[i+1])i++;const le=LENGTH_EXTRA[i];symbol(257+i);if(le)putBits(len-LENGTH_BASE[i],le);let d=0;while(d<29&&dist>=DISTANCE_BASE[d+1])d++;putBits(reverseBits(d,5),5);const de=DISTANCE_EXTRA[d];if(de)putBits(dist-DISTANCE_BASE[d],de);}putBits(1,1);putBits(1,2);const last=new Int32Array(65536).fill(-1),key=(i)=>((input[i]*251+input[i+1])*251+input[i+2])&65535;let i=0;while(i<input.length){if(i+3<input.length){const k=key(i),prev=last[k];last[k]=i;if(prev>=0&&i-prev<=32768&&input[i]===input[prev]&&input[i+1]===input[prev+1]&&input[i+2]===input[prev+2]){let len=3;while(len<258&&i+len<input.length&&input[i+len]===input[prev+len])len++;if(len>=4){match(len,i-prev);for(let j=1;j<len;j++)if(i+j+2<input.length)last[key(i+j)]=i+j;i+=len;continue;}}}symbol(input[i]);i++;}symbol(256);if(bitCount)out.push(bitAcc&255);return Uint8Array.from(out);}

function zlib(input){const deflated=fixedDeflate(input);let a=1,b=0;for(const v of input){a=(a+v)%65521;b=(b+a)%65521;}return cat([Uint8Array.of(0x78,0x01),deflated,w32be(((b<<16)|a)>>>0)]);}

function crc32(input){let c=0xffffffff;for(const byte of input){c^=byte;for(let i=0;i<8;i++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);}return (c^0xffffffff)>>>0;}

function chunk(tag,data){const payload=cat([ascii(tag),data]);return cat([w32be(data.length),payload,w32be(crc32(payload))]);}

function png(size,pixels){const raw=new Uint8Array(size*(size*4+1)),span=size*4;for(let y=0;y<size;y++)raw.set(pixels.subarray(y*span,(y+1)*span),y*(span+1)+1);const ihdr=new Uint8Array(13);put(ihdr,0,w32be(size));put(ihdr,4,w32be(size));ihdr[8]=8;ihdr[9]=6;return cat([Uint8Array.of(137,80,78,71,13,10,26,10),chunk("IHDR",ihdr),chunk("IDAT",zlib(raw)),chunk("IEND",new Uint8Array(0))]);}

function ico(images){const pick=[16,32,48,64,128,256],header=new Uint8Array(6+16*pick.length);put(header,2,w16le(1));put(header,4,w16le(pick.length));let offset=header.length;const parts=pick.map((size,i)=>{const data=images.get(size),at=6+16*i;header[at]=size===256?0:size;header[at+1]=size===256?0:size;put(header,at+4,w16le(1));put(header,at+6,w16le(32));put(header,at+8,w32le(data.length));put(header,at+12,w32le(offset));offset+=data.length;return data;});return cat([header,...parts]);}

function icns(images){const sizes=[["icp4",16],["icp5",32],["icp6",64],["ic07",128],["ic08",256],["ic09",512],["ic10",1024],["ic11",32],["ic12",64],["ic13",256],["ic14",512]],chunks=sizes.map(([name,size])=>{const data=images.get(size);return cat([ascii(name),w32be(8+data.length),data]);});return cat([ascii("icns"),w32be(8+chunks.reduce((s,c)=>s+c.length,0)),...chunks]);}

function generateAssets(){const images=new Map();for(const size of [16,32,48,64,128,256,512,1024])images.set(size,png(size,raster(size)));return new Map([["icon.png",images.get(1024)],["icon.ico",ico(images)],["icon.icns",icns(images)]]);}

export {generateAssets};
