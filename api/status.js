// language: JavaScript, file: api/status.js
"use strict";

const { wasmAvailable } = require("../lib/obfuscator");

module.exports = function handler(req, res){
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
        ok: true,
        luac: wasmAvailable() ? "available" : "missing",
        node: process.version,
        platform: process.platform
    });
};
