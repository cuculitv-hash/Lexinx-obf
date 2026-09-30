// language: JavaScript, file: api/obfuscate.js, target: Vercel Node 18+
"use strict";

const { obfuscate, wasmAvailable } = require("../lib/obfuscator");

module.exports = async function handler(req, res){
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if(req.method === "OPTIONS"){
        res.status(204).end();
        return;
    }

    if(req.method === "GET"){
        res.status(200).json({
            ok: true,
            luac: wasmAvailable() ? "wasm" : "fallback",
            node: process.version,
            platform: process.platform
        });
        return;
    }

    if(req.method !== "POST"){
        res.status(405).json({ ok: false, error: "Method not allowed" });
        return;
    }

    try{
        let body = req.body;
        if(typeof body === "string"){
            try{ body = JSON.parse(body); }catch(_){ body = {}; }
        }
        const { source, options } = body || {};

        if(typeof source !== "string" || !source.trim()){
            res.status(400).json({ ok: false, error: "Nguồn rỗng." });
            return;
        }

        if(source.length > 5_000_000){
            res.status(413).json({ ok: false, error: "Nguồn quá lớn (max 5MB)." });
            return;
        }

        const result = obfuscate(source, options || {});

        res.status(200).json({
            ok: true,
            output: result.output,
            luacUsed: result.luacUsed,
            stats: result.stats
        });
    }catch(err){
        console.error(err);
        res.status(500).json({ ok: false, error: String(err.message || err) });
    }
};
