/**
 * SQLite 只读访问助手 —— 通过 koffi FFI 直调 Windows 内置 winsqlite3.dll
 * 零新增依赖（koffi 已是项目依赖；winsqlite3.dll 为 Windows 10+ 系统自带）。
 * 供 codex / hermes 的通道 A adapter 复用。
 *
 * 说明：Electron 33 内置 Node 20 无 node:sqlite，故用 FFI；仅读不写。
 */
import * as path from 'path'
import * as fs from 'fs'

const SQLITE_ROW = 100
const SQLITE_OPEN_READONLY = 1

type ColType = number
const SQLITE_INTEGER = 1
const SQLITE_FLOAT = 2
const SQLITE_TEXT = 3

export type SqlValue = string | number | null
export type SqlRow = Record<string, SqlValue>

interface SqliteFuncs {
  open_v2: (filename: string, db: unknown[], flags: number, vfs: string | null) => number
  prepare: (db: unknown, sql: string, n: number, stmt: unknown[], tail: unknown) => number
  step: (stmt: unknown) => number
  colType: (stmt: unknown, i: number) => ColType
  colText: (stmt: unknown, i: number) => string
  colInt: (stmt: unknown, i: number) => unknown
  colDouble: (stmt: unknown, i: number) => number
  colCount: (stmt: unknown) => number
  colName: (stmt: unknown, i: number) => string
  finalize: (stmt: unknown) => number
  close: (db: unknown) => number
}

let sqlite: SqliteFuncs | null = null

/** 懒加载 winsqlite3.dll 符号；加载失败返回 null（优雅降级） */
function loadSqlite(): SqliteFuncs | null {
  if (sqlite) return sqlite
  try {
    // koffi 为原生模块，加载失败即降级（与 win32-window 同一策略）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as { load: (lib: string) => { func: (proto: string) => unknown } }
    const lib = koffi.load('winsqlite3.dll')
    sqlite = {
      open_v2: lib.func('int sqlite3_open_v2(const char *filename, _Out_ void **ppDb, int flags, const char *zVfs)') as SqliteFuncs['open_v2'],
      prepare: lib.func('int sqlite3_prepare_v2(void *db, const char *zSql, int nByte, _Out_ void **ppStmt, const char **pzTail)') as SqliteFuncs['prepare'],
      step: lib.func('int sqlite3_step(void *pStmt)') as SqliteFuncs['step'],
      colType: lib.func('int sqlite3_column_type(void *pStmt, int iCol)') as SqliteFuncs['colType'],
      colText: lib.func('const char *sqlite3_column_text(void *pStmt, int iCol)') as SqliteFuncs['colText'],
      colInt: lib.func('int64 sqlite3_column_int64(void *pStmt, int iCol)') as SqliteFuncs['colInt'],
      colDouble: lib.func('double sqlite3_column_double(void *pStmt, int iCol)') as SqliteFuncs['colDouble'],
      colCount: lib.func('int sqlite3_column_count(void *pStmt)') as SqliteFuncs['colCount'],
      colName: lib.func('const char *sqlite3_column_name(void *pStmt, int iCol)') as SqliteFuncs['colName'],
      finalize: lib.func('int sqlite3_finalize(void *pStmt)') as SqliteFuncs['finalize'],
      close: lib.func('int sqlite3_close(void *db)') as SqliteFuncs['close']
    }
    return sqlite
  } catch {
    sqlite = null
    return null
  }
}

/** 判断 sqlite 访问是否可用 */
export function sqliteAvailable(): boolean {
  return loadSqlite() !== null
}

/** 打开只读连接；失败返回 null */
export class SqliteDb {
  private db: unknown | null = null
  private f: SqliteFuncs

  private constructor(f: SqliteFuncs, db: unknown) {
    this.f = f
    this.db = db
  }

  static open(filePath: string): SqliteDb | null {
    if (!fs.existsSync(filePath)) return null
    const f = loadSqlite()
    if (!f) return null
    const dbPtr: unknown[] = [null]
    const rc = f.open_v2(filePath, dbPtr, SQLITE_OPEN_READONLY, null)
    if (rc !== 0 || !dbPtr[0]) return null
    return new SqliteDb(f, dbPtr[0])
  }

  /**
   * schema 守卫（OD#3）：探测表是否存在。
   * 上游（codex/hermes）版本升级改表结构时，adapter 据此优雅降级而非反复查询报错。
   */
  tableExists(name: string): boolean {
    if (!this.db) return false
    const rows = this.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${name.replace(/'/g, "''")}'`
    )
    return rows.length > 0
  }

  /** 执行查询，返回类型化行数组（单次连接内完成） */
  query(sql: string): SqlRow[] {
    if (!this.db) return []
    const stmtPtr: unknown[] = [null]
    const rc = this.f.prepare(this.db, sql, -1, stmtPtr, null)
    if (rc !== 0 || !stmtPtr[0]) return []
    const stmt = stmtPtr[0]
    const cols = this.f.colCount(stmt)
    const names: string[] = []
    for (let i = 0; i < cols; i++) names.push(this.f.colName(stmt, i))

    const rows: SqlRow[] = []
    while (this.f.step(stmt) === SQLITE_ROW) {
      const row: SqlRow = {}
      for (let i = 0; i < cols; i++) {
        row[names[i]] = this.readValue(stmt, i)
      }
      rows.push(row)
    }
    this.f.finalize(stmt)
    return rows
  }

  private readValue(stmt: unknown, i: number): SqlValue {
    const t = this.f.colType(stmt, i)
    switch (t) {
      case SQLITE_INTEGER: {
        const v = this.f.colInt(stmt, i)
        // koffi 的 int64 可能返回 BigInt 或 number，统一转 number（时间戳在安全整数范围）
        return typeof v === 'bigint' ? Number(v) : (v as number)
      }
      case SQLITE_FLOAT:
        return this.f.colDouble(stmt, i)
      case SQLITE_TEXT:
        return this.f.colText(stmt, i)
      default:
        return null // NULL / BLOB
    }
  }

  close(): void {
    if (this.db) {
      this.f.close(this.db)
      this.db = null
    }
  }
}

/** 数据目录下 helpers 子路径拼接（供 adapter 探测/输出用） */
export function homeDot(name: string): string {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', name)
}
