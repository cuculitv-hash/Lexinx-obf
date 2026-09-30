#!/usr/bin/env bash
# language: bash, file: build-wasm.sh, target: Linux/macOS with emscripten
# Build luac.wasm từ Lua 5.1.5 source, copy vào ./wasm/luac.wasm

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${SCRIPT_DIR}/.build-wasm"
WASM_OUT="${SCRIPT_DIR}/wasm/luac.wasm"

echo "=== LEXINX luac.wasm builder ==="
echo "Working dir: ${WORK_DIR}"
echo "Output: ${WASM_OUT}"
echo ""

# ---- Step 1: check emscripten ----
if ! command -v emcc >/dev/null 2>&1; then
    echo "ERROR: emcc not found. Install emscripten first:"
    echo ""
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk"
    echo "  ./emsdk install latest"
    echo "  ./emsdk activate latest"
    echo "  source ./emsdk_env.sh"
    echo ""
    exit 1
fi

echo "[1/5] emcc version:"
emcc --version | head -1
echo ""

# ---- Step 2: get Lua 5.1.5 ----
mkdir -p "${WORK_DIR}"
cd "${WORK_DIR}"

if [ ! -d "lua-5.1.5" ]; then
    echo "[2/5] Cloning Lua 5.1.5..."
    git clone --depth 1 --branch v5.1.5 https://github.com/lua/lua.git lua-5.1.5
else
    echo "[2/5] Lua 5.1.5 source already present"
fi

cd lua-5.1.5

# ---- Step 3: write C entry point ----
echo "[3/5] Writing lexinx_luac.c..."

cat > lexinx_luac.c <<'CEOF'
/* language: C, file: lexinx_luac.c, target: emscripten */
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include "ldebug.h"
#include "lundump.h"

static unsigned char* g_buf = NULL;
static int g_len = 0;

typedef struct {
    unsigned char* data;
    int len;
    int cap;
} DumpBuf;

static int writer(lua_State* L, const void* p, size_t sz, void* ud){
    (void)L;
    DumpBuf* b = (DumpBuf*)ud;
    if(b->len + (int)sz > b->cap){
        int newcap = (b->cap + (int)sz) * 2 + 64;
        unsigned char* nd = (unsigned char*)realloc(b->data, newcap);
        if(!nd) return 1;
        b->data = nd;
        b->cap = newcap;
    }
    memcpy(b->data + b->len, p, sz);
    b->len += (int)sz;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int luac_compile(const char* src, int srcLen){
    lua_State* L = luaL_newstate();
    if(!L) return -1;

    if(luaL_loadbuffer(L, src, srcLen, "@input") != 0){
        lua_close(L);
        return -1;
    }

    DumpBuf buf = { NULL, 0, 0 };
    int r = lua_dump(L, writer, &buf);
    if(r != 0){
        free(buf.data);
        lua_close(L);
        return -1;
    }

    if(g_buf) free(g_buf);
    g_buf = buf.data;
    g_len = buf.len;

    lua_close(L);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
unsigned char* get_buffer(void){ return g_buf; }

EMSCRIPTEN_KEEPALIVE
int get_buffer_len(void){ return g_len; }
CEOF

# ---- Step 4: build ----
echo "[4/5] Building luac.wasm (this takes ~30s)..."

emcc lexinx_luac.c \
    src/lapi.c src/lcode.c src/ldebug.c src/ldo.c src/ldump.c \
    src/lfunc.c src/lgc.c src/llex.c src/lmem.c src/lobject.c \
    src/lopcodes.c src/lparser.c src/lstate.c src/lstring.c \
    src/ltable.c src/ltm.c src/lundump.c src/lvm.c src/lzio.c \
    src/lauxlib.c src/lbaselib.c src/ldblib.c src/liolib.c \
    src/lmathlib.c src/loslib.c src/ltablib.c src/lstrlib.c \
    src/loadlib.c src/linit.c \
    -I src \
    -O3 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS='["_luac_compile","_get_buffer","_get_buffer_len","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='[]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s STANDALONE_WASM=1 \
    -s NO_EXIT_RUNTIME=1 \
    -s FILESYSTEM=0 \
    --no-entry \
    -o luac.wasm

# ---- Step 5: verify + copy ----
echo "[5/5] Verifying output..."

if [ ! -f "luac.wasm" ]; then
    echo "ERROR: luac.wasm not produced"
    exit 1
fi

MAGIC=$(xxd -p -l 4 luac.wasm)
if [ "$MAGIC" != "0061736d" ]; then
    echo "ERROR: luac.wasm has wrong magic word: $MAGIC"
    echo "Expected: 0061736d (\\0asm)"
    exit 1
fi

SIZE=$(stat -c%s luac.wasm 2>/dev/null || stat -f%z luac.wasm)
echo "OK: luac.wasm is valid WASM, size: ${SIZE} bytes"

mkdir -p "${SCRIPT_DIR}/wasm"
cp luac.wasm "${WASM_OUT}"

echo ""
echo "=== DONE ==="
echo "Output: ${WASM_OUT}"
echo "Size: ${SIZE} bytes"
echo ""
echo "Next steps:"
echo "  git add wasm/luac.wasm"
echo "  git commit -m 'Add compiled luac.wasm'"
echo "  git push"
echo "  vercel --prod --force"
