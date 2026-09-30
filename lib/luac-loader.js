// language: JavaScript, file: lib/luac-loader.js, target: Node 18+ (Vercel serverless)
"use strict";

const fs = require("fs");
const path = require("path");

let wasmInstance = null;
let wasmMemory = null;
let wasmExports = null;

function loadWasmOnce(){
    if(wasmExports) return wasmExports;

    const wasmPath = path.join(process.cwd(), "wasm", "luac.wasm");
    if(!fs.existsSync(wasmPath)) return null;

    const bytes = fs.readFileSync(wasmPath);

    // Vercel Node runtime hỗ trợ WebAssembly.instantiateSync
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
            fd_seek: function(){ return 0; }
        }
    });

    wasmInstance = instance;
    wasmExports = instance.exports;
    wasmMemory = wasmExports.memory;
    return wasmExports;
}

/* Signature C:
     int luac_compile(const char* src, int srcLen);
     const unsigned char* get_buffer(void);
     int get_buffer_len(void);
   Trả về Array<number> bytecode, hoặc null nếu wasm fail. */

function compileWithWasm(source){
    const ex = loadWasmOnce();
    if(!ex) return null;

    try{
        const srcBytes = Buffer.from(source, "utf8");
        const srcLen = srcBytes.length;
        const srcPtr = ex.malloc(srcLen + 1);
        if(!srcPtr) return null;

        const heap = new Uint8Array(wasmMemory.buffer);
        heap.set(srcBytes, srcPtr);
        heap[srcPtr + srcLen] = 0;

        const status = ex.luac_compile(srcPtr, srcLen);
        ex.free(srcPtr);

        if(status !== 0) return null;

        const outPtr = ex.get_buffer();
        const outLen = ex.get_buffer_len();
        if(!outPtr || !outLen) return null;

        const out = new Uint8Array(wasmMemory.buffer, outPtr, outLen);
        return Array.from(out);
    }catch(e){
        console.error("wasm compile error", e);
        return null;
    }
}

function wasmAvailable(){
    const wasmPath = path.join(process.cwd(), "wasm", "luac.wasm");
    return fs.existsSync(wasmPath);
}

module.exports = { compileWithWasm, wasmAvailable, loadWasmOnce };
