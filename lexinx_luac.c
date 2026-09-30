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
