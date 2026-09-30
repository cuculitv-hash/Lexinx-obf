// language: JavaScript, file: lib/luac-loader.js, target: Node 18+ (Vercel serverless)
"use strict";

const fs = require("fs");
const path = require("path");

let wasmInstance = null;
let wasmMemory = null;
let wasmExports = null;
let wasmTried = false;      // chỉ thử load 1 lần, tránh retry loop

function verifyMagicWord(bytes){
    if(!bytes || bytes.length < 8) return false;
    return bytes[0] === 0x00 &&
           bytes[1] === 0x61 &&
           bytes[2] === 0x73 &&
           bytes[3] === 0x6d;
}

function loadWasmOnce(){
    if(wasmExports) return wasmExports;
    if(wasmTried) return null;
    wasmTried = true;

    const wasmPath = path.join(process.cwd(), "wasm", "luac.wasm");

    if(!fs.existsSync(wasmPath)){
        console.warn("[lexinx] luac.wasm not found at", wasmPath, "— fallback mode");
        return null;
    }

    let bytes;
    try{
        bytes = fs.readFileSync(wasmPath);
    }catch(e){
        console.warn("[lexinx] cannot read luac.wasm:", e.message, "— fallback mode");
        return null;
    }

    if(!verifyMagicWord(bytes)){
        const first8 = Array.from(bytes.slice(0, 8))
            .map(b => b.toString(16).padStart(2, "0"))
            .join(" ");
        console.warn("[lexinx] luac.wasm has invalid magic word. First bytes:", first8);
        console.warn("[lexinx] Expected: 00 61 73 6d 01 00 00 00 (wasm binary)");
        console.warn("[lexinx] File is likely a text placeholder or LFS pointer — fallback mode");
        return null;
    }

    try{
        const mod = new WebAssembly.Module(bytes);
        const instance = new WebAssembly.Instance(mod, {
            env: {
                emscripten_notify_memory_growth: function(){},
                abort: function(){ throw new Error("wasm abort"); }
            },
            wasi_snapshot_preview1: {
                proc_exit: function(){},
                fd_write: function(){ return 0; },
                fd_close: function(){ return 0; },
                fd_seek: function(){ return 0; },
                fd_read: function(){ return 0; },
                environ_sizes_get: function(){ return 0; },
                environ_get: function(){ return 0; },
                clock_time_get: function(){ return 0; }
            }
        });

        wasmInstance = instance;
        wasmExports = instance.exports;
        wasmMemory = wasmExports.memory;

        if(!wasmMemory){
            console.warn("[lexinx] luac.wasm has no exported memory — fallback mode");
            wasmExports = null;
            return null;
        }

        if(typeof wasmExports.luac_compile !== "function" ||
           typeof wasmExports.get_buffer !== "function" ||
           typeof wasmExports.get_buffer_len !== "function"){
            console.warn("[lexinx] luac.wasm missing required exports — fallback mode");
            console.warn("[lexinx] Need: luac_compile, get_buffer, get_buffer_len");
            wasmExports = null;
            return null;
        }

        console.log("[lexinx] luac.wasm loaded OK, native bytecode compile enabled");
        return wasmExports;

    }catch(e){
        console.warn("[lexinx] wasm instantiate failed:", e.message, "— fallback mode");
        wasmExports = null;
        return null;
    }
}

function compileWithWasm(source){
    const ex = loadWasmOnce();
    if(!ex) return null;

    try{
        const srcBytes = Buffer.from(source, "utf8");
        const srcLen = srcBytes.length;

        const srcPtr = ex.malloc(srcLen + 1);
        if(!srcPtr){
            console.warn("[lexinx] wasm malloc failed");
            return null;
        }

        const heap = new Uint8Array(wasmMemory.buffer);
        heap.set(srcBytes, srcPtr);
        heap[srcPtr + srcLen] = 0;

        const status = ex.luac_compile(srcPtr, srcLen);
        ex.free(srcPtr);

        if(status !== 0){
            console.warn("[lexinx] luac_compile returned", status, "— using fallback");
            return null;
        }

        const outPtr = ex.get_buffer();
        const outLen = ex.get_buffer_len();

        if(!outPtr || !outLen){
            console.warn("[lexinx] wasm output buffer empty");
            return null;
        }

        const out = new Uint8Array(wasmMemory.buffer, outPtr, outLen);
        return Array.from(out);

    }catch(e){
        console.error("[lexinx] wasm compile error:", e.message);
        return null;
    }
}

function wasmAvailable(){
    if(!wasmTried) loadWasmOnce();
    return wasmExports !== null;
}

module.exports = {
    compileWithWasm,
    wasmAvailable,
    loadWasmOnce,
    verifyMagicWord
};
