#!/usr/bin/env python3
"""Exercise patched upstream vnStat queries and final flush using real SQLite.

Only selected SQLite step/finalize calls are fault-injected; queries, traffic
writes, transactions and the two-interface flush loop come from exact v2.13.
The upstream fixtures are GPL-2.0, https://github.com/vergoh/vnstat/tree/v2.13.
"""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--include', help='Directory containing sqlite3.h')
parser.add_argument('--sqlite-lib', default='-lsqlite3')
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'scripts/tests/fixtures'
HASHES = {
    'vnstatd': '67aaca70427fe168141a80e600b9ff3ac4a75575e6e3fbffc1fd2aafda9a559f',
    'daemon': 'e08f6b635af9e20c7ad2577d04a5008038d790e4ef924ba3e77ddd17b100869a',
    'dbsql': '4a0b69350d115a206b42f51e4b1fd664a9dbe813b7ae93b0462837c7f7594cf7',
}


def function(source, signature):
    start = source.index(signature)
    return source[start:source.index('\n}\n', start) + 3]


with tempfile.TemporaryDirectory(prefix='vnstat-native-db-test-') as temp:
    work = Path(temp)
    (work / 'src').mkdir()
    for name, digest in HASHES.items():
        data = (FIXTURES / f'vnstat-2.13-{name}.c').read_bytes()
        assert hashlib.sha256(data).hexdigest() == digest, f'Unexpected {name} fixture'
        (work / f'src/{name}.c').write_bytes(data)
    subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i',
                    str(ROOT / 'port/patches/vnstat2/910-vt-flush-exit-status.patch')],
                   cwd=work, check=True, capture_output=True)
    dbsql = (work / 'src/dbsql.c').read_text()
    daemon = (work / 'src/daemon.c').read_text()
    prototypes = '''
int db_begintransaction(void); int db_committransaction(void); int db_rollbacktransaction(void);
int db_addinterface(const char *iface); int db_exec(const char *sql);
'''
    native = '\n'.join(function(dbsql, signature) for signature in [
        'uint64_t db_getinterfacecountbyname(', 'sqlite3_int64 db_getinterfaceid(',
        'int db_exec(', 'int db_begintransaction(', 'int db_committransaction(',
        'int db_rollbacktransaction(', 'int db_setactive(', 'int db_setupdated(',
        'int db_setcounters(', 'int db_addtraffic_dated(',
    ])
    flush = function(daemon, 'void flushcachetodisk(')
    harness = work / 'native.c'
    harness.write_text(r'''
#define _DEFAULT_SOURCE
#include <assert.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sqlite3.h>

sqlite3 *db;
int db_errcode, db_intransaction, debug;
char errorstring[1024];
struct {
    int32_t fiveminutehours, hourlydays, dailydays, monthlymonths, yearlyyears, topdayentries;
    const char *dbtzmodifier;
} cfg = {0, 1, 0, 0, 0, 0, ""};
#define PT_Error 1
#define PT_Warning 2
#define PT_Info 3
#define SLOWDBWARNLIMIT 99
static int created, handled;
static void printe(int type) { (void)type; }
static char *getifaceinquery(const char *iface) { (void)iface; return NULL; }
static unsigned getqueryinterfacecount(const char *iface) { (void)iface; return 0; }
static const char *db_get_date_generator(int range, int direct, const char *date) {
    (void)range; (void)direct; (void)date; return "'2026-09-13 00:00:00'";
}
/* Return a failure only for a selected statement and selected occurrence. */
static int fault_stage, fault_kind, fault_error, fault_ordinal, matched;
static const char *fault_iface;
static int matches(sqlite3_stmt *stmt) {
    const char *sql = sqlite3_sql(stmt);
    return fault_stage && sql && strstr(sql, fault_kind == 1 ? "select count(*)" : "select id") &&
           strstr(sql, fault_iface);
}
static int injected_step(sqlite3_stmt *stmt) {
    if (fault_stage == 1 && matches(stmt) && ++matched == fault_ordinal) {
        fault_stage = 0; return fault_error;
    }
    return sqlite3_step(stmt);
}
static int injected_finalize(sqlite3_stmt *stmt) {
    int inject = fault_stage == 2 && matches(stmt) && ++matched == fault_ordinal;
    int result = sqlite3_finalize(stmt);
    if (inject) { fault_stage = 0; return fault_error; }
    return result;
}
#define sqlite3_step injected_step
#define sqlite3_finalize injected_finalize
''' + prototypes + native + r'''
int db_addinterface(const char *iface) {
    char sql[256]; created++;
    sqlite3_snprintf(sizeof(sql), sql, "insert into interface(name) values('%q')", iface);
    return db_exec(sql);
}
typedef struct xferlog {
    uint64_t rx, tx;
    time_t timestamp;
    struct xferlog *next;
} xferlog;
typedef struct datacache {
    char interface[32];
    uint64_t currx, curtx;
    time_t updated;
    int active;
    xferlog *log;
    struct datacache *next;
} datacache;
typedef struct { uint64_t rxtotal, txtotal; } interfaceinfo;
typedef struct { datacache *dcache; int noremove, dbretrycount; } DSTATE;
static double timeused(const char *name, int start) { (void)name; (void)start; return 0; }
static void handledatabaseerror(DSTATE *state) { (void)state; handled++; }
static void xferlog_clear(xferlog **log) { *log = NULL; }
/* Unreachable in the shipped --noremove private instance. */
static int db_getinterfaceinfo(const char *iface, interfaceinfo *info) {
    (void)iface; (void)info; abort();
}
static int db_removeinterface(const char *iface) { (void)iface; abort(); }
''' + flush + r'''
#undef sqlite3_step
#undef sqlite3_finalize

static void configure_fault(int stage, int kind, const char *iface, int ordinal, int error) {
    fault_stage = stage; fault_kind = kind; fault_iface = iface;
    fault_ordinal = ordinal; fault_error = error; matched = 0;
    db_errcode = 0; handled = 0; created = 0;
}
static void reset(void) {
    fault_stage = 0;
    assert(sqlite3_open(":memory:", &db) == SQLITE_OK);
    assert(sqlite3_exec(db,
        "create table interface(id integer primary key, name text unique, active integer default 1, "
        "updated text, rxcounter integer default 0, txcounter integer default 0, "
        "rxtotal integer default 0, txtotal integer default 0);"
        "insert into interface(name) values('wwan0'),('wwan1');"
        "create table hour(interface integer, date text, rx integer, tx integer, unique(interface,date));",
        NULL, NULL, NULL) == SQLITE_OK);
    db_intransaction = 0; db_errcode = 0;
}
static sqlite3_int64 total(void) {
    sqlite3_stmt *stmt;
    assert(sqlite3_prepare_v2(db, "select sum(rxtotal) from interface", -1, &stmt, NULL) == SQLITE_OK);
    assert(sqlite3_step(stmt) == SQLITE_ROW);
    sqlite3_int64 result = sqlite3_column_int64(stmt, 0);
    assert(sqlite3_finalize(stmt) == SQLITE_OK);
    return result;
}
static void close_database(void) {
    assert(sqlite3_get_autocommit(db));
    assert(sqlite3_close(db) == SQLITE_OK);
    db = NULL;
}
int main(void) {
    int errors[] = { SQLITE_BUSY, SQLITE_LOCKED, SQLITE_IOERR, SQLITE_FULL };
    for (size_t e = 0; e < sizeof(errors) / sizeof(errors[0]); e++) {
        for (int stage = 1; stage <= 2; stage++) {
            /* Count failures must not become "interface absent". */
            reset(); configure_fault(stage, 1, "wwan0", 1, errors[e]);
            assert(db_getinterfacecountbyname("wwan0") == 0 && db_errcode == errors[e]);
            close_database();
            /* An unsuccessful SELECT cannot trigger create-if-missing. */
            reset(); configure_fault(stage, 2, "wwan0", 1, errors[e]);
            assert(db_getinterfaceid("wwan0", 1) == 0 && db_errcode == errors[e]);
            assert(created == 0);
            close_database();
            /* First interface is already written in the transaction when the
             * second lookup fails. Roll back BOTH; retain BOTH cached logs. */
            for (int kind = 1; kind <= 2; kind++) {
                int ordinals = kind == 1 ? 1 : 4;
                for (int ordinal = 1; ordinal <= ordinals; ordinal++) {
                    reset(); configure_fault(stage, kind, "wwan1", ordinal, errors[e]);
                    xferlog l0 = {100, 10, 1789257600, NULL}, l1 = {200, 20, 1789257600, NULL};
                    datacache d1 = {"wwan1", 200, 20, 1789257610, 1, &l1, NULL};
                    datacache d0 = {"wwan0", 100, 10, 1789257610, 1, &l0, &d1};
                    DSTATE state = { &d0, 1, 0 };
                    flushcachetodisk(&state);
                    assert(db_errcode != SQLITE_OK && handled > 0);
                    assert(d0.log == &l0 && d1.log == &l1 && total() == 0);
                    assert(sqlite3_get_autocommit(db));
                    /* Retry commits the retained data once, not twice. */
                    fault_stage = 0;
                    flushcachetodisk(&state);
                    assert(db_errcode == SQLITE_OK && total() == 300 && !d0.log && !d1.log);
                    close_database();
                }
            }
        }
    }
    /* A real prepare failure must not enter the create-if-missing fallback. */
    reset(); configure_fault(0, 0, "", 1, 0);
    assert(sqlite3_exec(db, "drop table interface", NULL, NULL, NULL) == SQLITE_OK);
    assert(db_getinterfacecountbyname("wwan0") == 0 && db_errcode == SQLITE_ERROR);
    db_errcode = SQLITE_OK;
    assert(db_getinterfaceid("wwan0", 1) == 0 && db_errcode == SQLITE_ERROR && !created);
    close_database();
    /* Actual missing rows keep their legitimate create behavior. */
    reset(); configure_fault(0, 0, "", 1, 0);
    assert(db_getinterfacecountbyname("missing") == 0 && db_errcode == SQLITE_OK);
    assert(db_getinterfaceid("missing", 0) == 0 && !created && db_errcode == SQLITE_OK);
    assert(db_getinterfaceid("missing", 1) > 0 && created == 1 && db_errcode == SQLITE_OK);
    close_database();
    puts("VNSTAT_NATIVE_DB_ERRORS_TESTS_OK");
    return 0;
}
''')
    binary = work / 'native'
    command = [os.environ.get('CC', 'cc'), '-O2', '-Wall', '-Wextra', '-Werror']
    if args.include:
        command += ['-I', args.include]
    subprocess.run(command + [str(harness), args.sqlite_lib, '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=15)
