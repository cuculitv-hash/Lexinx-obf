// language: JavaScript, file: lib/obfuscator.js, target: Node 18+ (Vercel)
"use strict";

const crypto = require("crypto");
const { compileWithWasm, wasmAvailable } = require("./luac-loader");

function randU32(){ return crypto.randomInt(0, 0x7fffffff); }
function randBytes(n){ return Array.from(crypto.randomBytes(n)); }

function mix32(x){
    x >>>= 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x45d9f3b) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x45d9f3b) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
}

function fnvBytes(arr){
    let h = 2166136261 >>> 0;
    for(let i=0;i<arr.length;i++){
        h ^= arr[i] & 0xff;
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

function rotl8(v,n){ n&=7; if(!n) return v&255; return (((v<<n)&255)|(v>>(8-n)))&255; }

function rnd(a,b){ return crypto.randomInt(a, b+1); }

function ident(){
    const c = "abcdefghijklmnopqrstuvwxyz";
    let s = "_";
    const len = rnd(10,18);
    for(let i=0;i<len;i++) s += c[rnd(0,c.length-1)];
    return s;
}

function stripComments(src){
    let out="",i=0,q=null,esc=false;
    while(i<src.length){
        const c=src[i];
        if(q){
            out+=c;
            if(esc) esc=false;
            else if(c==="\\") esc=true;
            else if(c===q) q=null;
            i++; continue;
        }
        if(c==="\""||c==="'"){ q=c; out+=c; i++; continue; }
        if(c==="-"&&src[i+1]==="-"){
            if(src[i+2]==="["&&src[i+3]==="["){
                const e=src.indexOf("]]",i+4);
                if(e>=0){i=e+2;continue;}
            }
            while(i<src.length&&src[i]!=="\n") i++;
            continue;
        }
        out+=c;i++;
    }
    return out;
}

function splitKey(k){
    const a=rnd(0x10000000,0x7fffffff)>>>0;
    const b=(k^a)>>>0;
    const c=mix32((a^0xa5a5a5a5)>>>0);
    const d=(k^c)>>>0;
    return [a,b,c,d];
}

function deriveKey(data, salt){ return mix32((fnvBytes(data) ^ salt) >>> 0); }

function encodePayload(bytes,key,passes){
    const d = bytes.slice();
    const base = ((key>>>5)%7)+1;
    for(let p=0;p<passes;p++){
        for(let i=0;i<d.length;i++){
            const shift = ((i+p)%4)*8;
            const dyn = ((key>>>shift) ^ Math.imul(i+1,0x9e3779b1) ^ Math.imul(p+1,0x45d9f3b)) & 255;
            d[i] = rotl8(d[i]^dyn, (base+p+i)%8);
        }
    }
    return d;
}

function buildConstMask(seed,len){
    const mask = new Array(len);
    let s = seed>>>0;
    for(let i=0;i<len;i++){
        s = mix32((s+i+0x9e3779b9)>>>0);
        mask[i] = s&255;
    }
    return mask;
}

function encryptConstants(bytes,seed){
    const mask = buildConstMask(seed,bytes.length);
    const out = new Array(bytes.length);
    for(let i=0;i<bytes.length;i++) out[i] = (bytes[i]^mask[i])&255;
    return { stream: out, maskSeed: seed };
}

function opcodeSet(){
    const used = new Set();
    const next = () => {
        let x;
        do { x = rnd(32,245); } while(used.has(x));
        used.add(x);
        return x;
    };
    return { FUSED:next(), PUSH:next(), EMIT:next(), NOP:next(), HALT:next() };
}

function compileFused(data,op,useFuse){
    const out=[];
    if(useFuse){
        for(let i=0;i<data.length;i++){
            out.push(op.FUSED,data[i]);
            if((i%29)===0) out.push(op.NOP);
        }
    }else{
        for(let i=0;i<data.length;i++){
            out.push(op.PUSH,data[i]);
            if((i%11)===0) out.push(op.NOP);
            out.push(op.EMIT);
        }
    }
    out.push(op.HALT);
    return out;
}

function flattenStrict(bytecode){
    const n=bytecode.length;
    const order=Array.from({length:n},(_,i)=>i);
    for(let i=n-1;i>0;i--){
        const j=rnd(0,i);
        [order[i],order[j]]=[order[j],order[i]];
    }
    const phys=new Array(n);
    for(let p=0;p<n;p++) phys[order[p]]=p;
    const physical=new Array(n);
    for(let p=0;p<n;p++){
        const logical=order[p];
        const next = (logical+1>=n) ? -1 : phys[logical+1];
        physical[p]=[bytecode[logical],next];
    }
    return { physical, entry: phys[0] };
}

function genPrelude(n){
    const lines=[];
    for(let i=0;i<n;i++){
        const v = ident();
        const a = rnd(1,0xffff), b = rnd(1,0xffff);
        const op = rnd(0,3);
        if(op===0) lines.push(`local ${v}=${a}*${b}`);
        else if(op===1) lines.push(`local ${v}=(${a}+${b})~${a}`);
        else if(op===2) lines.push(`local ${v}=(${a}<<${rnd(1,8)})&0xffff`);
        else lines.push(`local ${v}=(${a}%${rnd(2,97)})^${b}`);
    }
    return lines;
}

function fallbackBytecode(source){
    const header = [0x1B,0x4C,0x75,0x61,0x51,0x01,0x04,0x04,0x04,0x08,0x00];
    const body = Array.from(Buffer.from(source, "utf8"));
    const len = body.length;
    const size = [len&0xff,(len>>8)&0xff,(len>>16)&0xff,(len>>24)&0xff];
    return header.concat(size).concat(body);
}

function buildInterpreter(opts){
    const {
        maskedPhysical, flattenedEntry, parts, salt, passes,
        maskSeed, dispatchSeedVal, expectedHash, preludeLines,
        useAntiHook, usePerOpKey, vm2MaskSeed, vm2DispatchSeed
    } = opts;

    const prelude = preludeLines.join("\n");
    const r = ident();
    const keyName = ident();
    const hashName = ident();
    const maskName = ident();
    const opF = ident(), opP = ident(), opE = ident(), opN = ident(), opH = ident();
    const dsName = ident();
    const junk = ident();
    const stateName = ident();
    const blk = ident();
    const tailName = ident();
    const iName = ident();
    const outName = ident();
    const expHash = ident();
    const v2MaskSeed = ident(), v2DS = ident();
    const v2Mask = ident();
    const v2F = ident(), v2P = ident(), v2E = ident(), v2N = ident(), v2H = ident();
    const v2Tail = ident();

    const perOpBlock = usePerOpKey ? `
    local function __pk(idx, k)
        local x=(k~(idx*0x9e3779b1))&0xffffffff
        return mix(x)&255
    end
` : `local function __pk(idx,k) return 0 end`;

    const antiHookBlock = useAntiHook ? `
    local function __freeze(t)
        local mt=getmetatable(t)
        if not mt then mt={} end
        mt.__newindex=function() end
        setmetatable(t,mt)
    end
    if string then __freeze(string) end
    if debug then __freeze(debug) end
    if os then __freeze(os) end
` : "";

    const machineLiteral = `{${maskedPhysical.map(([o,n])=>`${o},${n}`).join(",")}}`;

    return `
-- This script is by lexinx v3

${prelude}

local ${r}=(function()

local function mix(v)
    v=(v~(v>>16))&0xffffffff
    v=((v*0x45d9f3b)&0xffffffff)
    v=(v~(v>>16))&0xffffffff
    v=((v*0x45d9f3b)&0xffffffff)
    v=(v~(v>>16))&0xffffffff
    return v&0xffffffff
end

local function br(v,n)
    n=n&7
    if n==0 then return v&255 end
    return ((v>>n)|((v<<(8-n))&255))&255
end

${antiHookBlock}
${perOpBlock}

local ${junk}=(${rnd(1,0xffff)}*${rnd(1,0xffff)})%${rnd(2,97)}

local ${keyName}=mix((${parts[0]}~${parts[1]}~${parts[2]}~${parts[3]}~${salt})&0xffffffff)

local ${dsName}=${dispatchSeedVal}
local ${opF}=mix((${dsName}+1)&0xffffffff)&255
local ${opP}=mix((${dsName}+2)&0xffffffff)&255
local ${opE}=mix((${dsName}+3)&0xffffffff)&255
local ${opN}=mix((${dsName}+4)&0xffffffff)&255
local ${opH}=mix((${dsName}+5)&0xffffffff)&255

local ${maskName}={}
do
    local s=${maskSeed}>>>0
    for i=1,${maskedPhysical.length} do
        s=mix((s+i-1+0x9e3779b9)&0xffffffff)
        ${maskName}[i]=s&255
    end
end

local ${stateName}=${flattenedEntry+1}
local ${blk}=${machineLiteral}
local ${tailName}={}

while ${stateName}~=-1 do
    local entry=${blk}[${stateName}]
    local rawOp=entry[1]
    local idx=(${stateName}-1)%#${maskName}+1
    local opcode
    ${usePerOpKey ? `opcode=(rawOp~__pk(${stateName},${keyName}))&255` : `opcode=(rawOp~${maskName}[idx])&255`}

    if opcode==${opF} then
        ${stateName}=${stateName}+1
        local nxt=${blk}[${stateName}]
        local nIdx=(${stateName}-1)%#${maskName}+1
        local operand
        ${usePerOpKey ? `operand=(nxt[1]~__pk(${stateName},${keyName}))&255` : `operand=(nxt[1]~${maskName}[nIdx])&255`}
        ${tailName}[#${tailName}+1]=operand
    elseif opcode==${opP} then
        ${stateName}=${stateName}+1
        local nxt=${blk}[${stateName}]
        ${tailName}[#${tailName}+1]=nxt[1]&255
    elseif opcode==${opE} then
        local v=${tailName}[#${tailName}]
        ${tailName}[#${tailName}]=nil
        ${tailName}[#${tailName}+1]=v&255
    elseif opcode==${opN} then
    elseif opcode==${opH} then
        break
    else
        error("X")
    end
    ${stateName}=entry[2]
end

for ${iName}=1,#${tailName} do
    local idx=${iName}-1
    local dyn=(((${keyName}>>((idx+0)%4*8)))~((idx+1)*0x9e3779b1))&255
    ${tailName}[${iName}]=br(${tailName}[${iName}],((${((passes+3)%8)}+${iName})%8))
    ${tailName}[${iName}]=((${tailName}[${iName}]~dyn)&255)
end

local ${hashName}=0
for ${iName}=1,#${tailName} do
    ${hashName}=(((${hashName}~${tailName}[${iName}])*16777619)&0x7fffffff)
end
local ${expHash}=${expectedHash}
if ${hashName}~=${expHash} then error("I") end

local ${v2MaskSeed}=${vm2MaskSeed}
local ${v2DS}=${vm2DispatchSeed}
local ${v2Mask}={}
do
    local s=${v2MaskSeed}>>>0
    for i=1,#${tailName} do
        s=mix((s+i-1+0x9e3779b9)&0xffffffff)
        ${v2Mask}[i]=s&255
    end
end
local ${v2F}=mix((${v2DS}+1)&0xffffffff)&255
local ${v2P}=mix((${v2DS}+2)&0xffffffff)&255
local ${v2E}=mix((${v2DS}+3)&0xffffffff)&255
local ${v2N}=mix((${v2DS}+4)&0xffffffff)&255
local ${v2H}=mix((${v2DS}+5)&0xffffffff)&255

local ${v2Tail}={}
for ${iName}=1,#${tailName} do
    ${v2Tail}[${iName}]=(${tailName}[${iName}]~${v2Mask}[${iName}])&255
end

local ${outName}={}
for ${iName}=1,#${v2Tail} do
    local b=${v2Tail}[${iName}]
    local idx=${iName}-1
    local k=(((${keyName}>>((idx+0)%4*8)))~((idx+1)*0x9e3779b1))&255
    b=(b~k)&255
    b=br(b,((${((passes+3)%8)}+${iName})%8))
    ${outName}[${iName}]=string.char(b&255)
end

return table.concat(${outName})

end)()

local __fn,__e
__fn,__e=load(${r},nil,"b")
if not __fn then __fn,__e=(loadstring or load)(${r}) end
if not __fn then error("C "..tostring(__e)) end
return __fn()
`;
}

function obfuscate(source, options){
    const opts = Object.assign({
        singleLine: false,
        dualVM: true,
        fragment: true,
        shuffle: true,
        multiPass: true,
        poly: true,
        fuse: true,
        antiHook: true,
        flatten: true,
        stripComments: true,
        perOpKey: true
    }, options || {});

    let src = source;
    if(opts.stripComments) src = stripComments(src);

    let raw = null;
    let luacUsed = false;
    const compiled = compileWithWasm(src);
    if(compiled){
        raw = compiled;
        luacUsed = true;
    }else{
        raw = fallbackBytecode(src);
    }

    const salt = fnvBytes(randBytes(12));
    const key = deriveKey(raw, salt);
    const parts = splitKey(key);
    const passes = opts.multiPass ? rnd(2,4) : 1;
    const encoded = encodePayload(raw, key, passes);

    const op = opcodeSet();
    let bytecode = compileFused(encoded, op, opts.fuse);

    let preludeLines = [];
    if(opts.poly) preludeLines = genPrelude(rnd(60,120));

    let maskSeed = randU32();
    const enc = encryptConstants(bytecode, maskSeed);
    bytecode = enc.stream;

    let fragments;
    if(opts.fragment){
        fragments = [];
        let p = 0;
        while(p < bytecode.length){
            const n = Math.min(bytecode.length - p, rnd(20,64));
            fragments.push(bytecode.slice(p, p+n));
            p += n;
        }
        if(!fragments.length) fragments = [[]];
    }else{
        fragments = [bytecode];
    }

    let order;
    if(opts.shuffle){
        order = fragments.map((_,i)=>i);
        for(let i=order.length-1;i>0;i--){
            const j=rnd(0,i);
            [order[i],order[j]]=[order[j],order[i]];
        }
    }else{
        order = fragments.map((_,i)=>i);
    }

    const physical = [];
    for(let i=0;i<order.length;i++) physical.push(fragments[order[i]]);
    const reconstructed = [];
    for(let i=0;i<order.length;i++) reconstructed.push(physical[order.indexOf(i)]);
    bytecode = reconstructed.flat();

    let flattened;
    if(opts.flatten){
        flattened = flattenStrict(bytecode);
    }else{
        flattened = {
            physical: bytecode.map((b,i)=>[b, i+1<bytecode.length?i+1:-1]),
            entry: 0
        };
    }

    const maskKeystream = buildConstMask(maskSeed, flattened.physical.length);
    const maskedPhysical = flattened.physical.map(([o,n],i)=>[(o^maskKeystream[i])&255, n]);

    let expectedHash = 0;
    for(let i=0;i<encoded.length;i++){
        expectedHash = Math.imul((expectedHash^encoded[i]),16777619)&0x7fffffff;
    }

    const dispatchSeedVal = randU32();
    const vm2MaskSeed = randU32();
    const vm2DispatchSeed = randU32();

    let output = buildInterpreter({
        maskedPhysical,
        flattenedEntry: flattened.entry,
        parts, salt, passes,
        maskSeed, dispatchSeedVal, expectedHash,
        preludeLines,
        useAntiHook: opts.antiHook,
        usePerOpKey: opts.perOpKey,
        vm2MaskSeed,
        vm2DispatchSeed
    });

    if(opts.singleLine){
        const lines = output.split("\n");
        const marker = lines.shift();
        const rest = lines.join(" ");
        output = marker + "\n" + rest;
    }

    return {
        output,
        luacUsed,
        stats: {
            sourceBytes: src.length,
            bytecodeBytes: raw.length,
            outputBytes: output.length,
            passes
        }
    };
}

module.exports = { obfuscate, wasmAvailable };
