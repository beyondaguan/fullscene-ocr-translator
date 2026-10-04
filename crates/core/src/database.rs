//! 翻译历史库（SQLite）。
//!
//! 每次翻译落一条记录，供欢迎页「最近翻译」与工作界面溯源使用。
//! 数据库文件位置见 PRODUCTION.md §6：`%APPDATA%/FullSceneOCR/fullscene.db`。
//!
//! 阶段 C1（划词生词本）：新增 `wordbook` 表，与 `history` 同库。
//! 划词动作同时写两张表（见 `docs/划词取词设计.md` §4.3）。

use crate::error::{AppError, Result};
use rusqlite::{params, Connection};

/// 一条翻译历史。
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryRow {
    pub id: i64,
    /// 原文
    pub source: String,
    /// 译文
    pub target: String,
    /// 使用的引擎 id
    pub engine: String,
    /// 创建时间（SQLite `CURRENT_TIMESTAMP`，UTC）
    pub created_at: String,
}

/// 一条生词本条目（与 `docs/划词取词设计.md` §4.2 DDL 对齐）。
///
/// `id` / `created_at` 在插入时由数据库生成，命令层传入时可缺省（`#[serde(default)]`）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WordEntry {
    #[serde(default)]
    pub id: i64,
    /// 选中的原文（词/词组/整句）。
    pub term: String,
    /// 译文。
    pub translation: String,
    /// 划词时所在句子（可空，M1 恒空）。
    #[serde(default)]
    pub context: Option<String>,
    /// 上下文译文（可空，M1 恒空）。
    #[serde(default)]
    pub context_translation: Option<String>,
    /// 实际出译文的引擎 id。
    #[serde(default = "default_engine")]
    pub engine: String,
    /// 源语言（划词固定 "auto"）。
    #[serde(default = "default_src_lang")]
    pub src_lang: String,
    /// 目标语言（划词固定 "zh"）。
    #[serde(default = "default_dst_lang")]
    pub dst_lang: String,
    /// 来源应用进程名（可空，M1 恒空）。
    #[serde(default)]
    pub source_app: Option<String>,
    /// 创建时间（SQLite `CURRENT_TIMESTAMP`，UTC）。
    #[serde(default)]
    pub created_at: String,
}

fn default_engine() -> String {
    "unknown".into()
}

fn default_src_lang() -> String {
    "auto".into()
}

fn default_dst_lang() -> String {
    "zh".into()
}

/// 历史库句柄。
pub struct Database {
    conn: Connection,
}

impl Database {
    /// 打开内存库（测试与 `open()` 失败时的兜底）
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| AppError::Config(format!("打开内存数据库失败: {e}")))?;
        let db = Self { conn };
        db.init()?;
        Ok(db)
    }

    /// 打开（必要时创建）指定路径的数据库文件
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(AppError::Io)?;
        }
        let conn =
            Connection::open(path).map_err(|e| AppError::Config(format!("打开数据库失败: {e}")))?;
        let db = Self { conn };
        db.init()?;
        Ok(db)
    }

    /// 建表（幂等）：`history` + `wordbook`（含两个索引）。
    pub fn init(&self) -> Result<()> {
        self.conn
            .execute(
                "CREATE TABLE IF NOT EXISTS history (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    source     TEXT NOT NULL,
                    target     TEXT NOT NULL,
                    engine     TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 )",
                [],
            )
            .map_err(|e| AppError::Config(format!("建表失败: {e}")))?;
        // 划词生词本（docs/划词取词设计.md §4.2）。review_state 恒 NULL（M1 预留 SM-2）。
        self.conn
            .execute(
                "CREATE TABLE IF NOT EXISTS wordbook (
                    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                    term                TEXT NOT NULL,
                    translation         TEXT NOT NULL,
                    context             TEXT,
                    context_translation TEXT,
                    engine              TEXT NOT NULL,
                    src_lang            TEXT NOT NULL DEFAULT 'auto',
                    dst_lang            TEXT NOT NULL DEFAULT 'zh',
                    source_app          TEXT,
                    review_state        TEXT,
                    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 )",
                [],
            )
            .map_err(|e| AppError::Config(format!("建 wordbook 表失败: {e}")))?;
        self.conn
            .execute(
                "CREATE INDEX IF NOT EXISTS idx_wordbook_created ON wordbook(created_at DESC)",
                [],
            )
            .map_err(|e| AppError::Config(format!("建 wordbook 索引失败: {e}")))?;
        self.conn
            .execute(
                "CREATE INDEX IF NOT EXISTS idx_wordbook_term ON wordbook(term)",
                [],
            )
            .map_err(|e| AppError::Config(format!("建 wordbook term 索引失败: {e}")))?;
        Ok(())
    }

    /// 写入一条历史，返回自增 id
    pub fn insert_history(&self, source: &str, target: &str, engine: &str) -> Result<i64> {
        self.conn
            .execute(
                "INSERT INTO history (source, target, engine) VALUES (?1, ?2, ?3)",
                params![source, target, engine],
            )
            .map_err(|e| AppError::Config(format!("写入历史失败: {e}")))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// 最近 N 条（新的在前）
    pub fn recent(&self, limit: usize) -> Result<Vec<HistoryRow>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, source, target, engine, created_at
                 FROM history ORDER BY id DESC LIMIT ?1",
            )
            .map_err(|e| AppError::Config(format!("查询历史失败: {e}")))?;
        let rows = stmt
            .query_map([limit as i64], |row| {
                Ok(HistoryRow {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    target: row.get(2)?,
                    engine: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| AppError::Config(format!("遍历历史失败: {e}")))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| AppError::Config(format!("读取历史失败: {e}")))
    }

    /// 清空历史
    pub fn clear(&self) -> Result<()> {
        self.conn
            .execute("DELETE FROM history", [])
            .map_err(|e| AppError::Config(format!("清空历史失败: {e}")))?;
        Ok(())
    }

    /// 写入一条生词本条目，返回自增 id（划词收藏 / 收藏按钮）。
    pub fn insert_word(&self, w: &WordEntry) -> Result<i64> {
        self.conn
            .execute(
                "INSERT INTO wordbook
                    (term, translation, context, context_translation, engine, src_lang, dst_lang, source_app)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    w.term,
                    w.translation,
                    w.context,
                    w.context_translation,
                    w.engine,
                    w.src_lang,
                    w.dst_lang,
                    w.source_app
                ],
            )
            .map_err(|e| AppError::Config(format!("写入生词本失败: {e}")))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// 列出生词本条目（新的在前）。`query` 非空时按 `term` / `translation` 模糊过滤。
    pub fn list_words(&self, limit: usize, query: Option<&str>) -> Result<Vec<WordEntry>> {
        let q = query.unwrap_or("").trim();
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, term, translation, context, context_translation, engine,
                        src_lang, dst_lang, source_app, created_at
                 FROM wordbook
                 WHERE (?2 = '' OR term LIKE '%' || ?2 || '%' OR translation LIKE '%' || ?2 || '%')
                 ORDER BY id DESC
                 LIMIT ?1",
            )
            .map_err(|e| AppError::Config(format!("查询生词本失败: {e}")))?;
        let rows = stmt
            .query_map(params![limit as i64, q], |row| {
                Ok(WordEntry {
                    id: row.get(0)?,
                    term: row.get(1)?,
                    translation: row.get(2)?,
                    context: row.get(3)?,
                    context_translation: row.get(4)?,
                    engine: row.get(5)?,
                    src_lang: row.get(6)?,
                    dst_lang: row.get(7)?,
                    source_app: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })
            .map_err(|e| AppError::Config(format!("遍历生词本失败: {e}")))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| AppError::Config(format!("读取生词本失败: {e}")))
    }

    /// 删除一条生词本条目（取消收藏）。
    pub fn delete_word(&self, id: i64) -> Result<()> {
        self.conn
            .execute("DELETE FROM wordbook WHERE id = ?1", [id])
            .map_err(|e| AppError::Config(format!("删除生词本失败: {e}")))?;
        Ok(())
    }

    /// 判断某原文是否已收藏（收藏按钮初始态）。
    pub fn is_word_saved(&self, term: &str) -> Result<bool> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM wordbook WHERE term = ?1",
                [term],
                |row| row.get(0),
            )
            .map_err(|e| AppError::Config(format!("查询收藏状态失败: {e}")))?;
        Ok(count > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_then_recent_returns_newest_first() {
        let db = Database::open_in_memory().unwrap();
        db.insert_history("hello", "你好", "local-llm").unwrap();
        db.insert_history("world", "世界", "local-llm").unwrap();

        let rows = db.recent(10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].source, "world"); // 新的在前
        assert_eq!(rows[1].target, "你好");
    }

    #[test]
    fn limit_is_respected() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..5 {
            db.insert_history(&format!("s{i}"), &format!("t{i}"), "local-llm")
                .unwrap();
        }
        assert_eq!(db.recent(2).unwrap().len(), 2);
    }

    #[test]
    fn clear_removes_all_rows() {
        let db = Database::open_in_memory().unwrap();
        db.insert_history("a", "b", "local-llm").unwrap();
        assert_eq!(db.recent(10).unwrap().len(), 1);
        db.clear().unwrap();
        assert!(db.recent(10).unwrap().is_empty());
    }

    #[test]
    fn created_at_is_populated_by_default() {
        let db = Database::open_in_memory().unwrap();
        db.insert_history("a", "b", "mymemory").unwrap();
        let rows = db.recent(1).unwrap();
        assert!(!rows[0].created_at.is_empty());
        assert_eq!(rows[0].engine, "mymemory");
    }

    // ------------------------------------------------------------------
    // 生词本（阶段 C1）
    // ------------------------------------------------------------------

    fn sample_word(term: &str) -> WordEntry {
        WordEntry {
            id: 0,
            term: term.into(),
            translation: format!("译:{term}"),
            context: None,
            context_translation: None,
            engine: "mymemory".into(),
            src_lang: "auto".into(),
            dst_lang: "zh".into(),
            source_app: None,
            created_at: String::new(),
        }
    }

    #[test]
    fn insert_word_then_list_newest_first() {
        let db = Database::open_in_memory().unwrap();
        let id1 = db.insert_word(&sample_word("hello")).unwrap();
        let id2 = db.insert_word(&sample_word("world")).unwrap();
        assert!(id1 > 0 && id2 > id1, "自增 id 应递增: {id1}, {id2}");

        let rows = db.list_words(10, None).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].term, "world", "新的在前");
        assert_eq!(rows[1].term, "hello");
        assert_eq!(rows[0].engine, "mymemory");
        assert_eq!(rows[0].src_lang, "auto");
        assert_eq!(rows[0].dst_lang, "zh");
        assert!(!rows[0].created_at.is_empty(), "created_at 应默认填充");
    }

    #[test]
    fn list_words_limit_is_respected() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..5 {
            db.insert_word(&sample_word(&format!("word{i}"))).unwrap();
        }
        assert_eq!(db.list_words(2, None).unwrap().len(), 2);
    }

    #[test]
    fn list_words_filters_by_query() {
        let db = Database::open_in_memory().unwrap();
        db.insert_word(&sample_word("apple")).unwrap();
        db.insert_word(&sample_word("banana")).unwrap();
        db.insert_word(&sample_word("pear")).unwrap();

        let rows = db.list_words(10, Some("an")).unwrap();
        assert_eq!(rows.len(), 1, "只有 banana 含 'an'");
        assert_eq!(rows[0].term, "banana");

        let all = db.list_words(10, Some("  ")).unwrap();
        assert_eq!(all.len(), 3, "空白 query 应返回全部");
    }

    #[test]
    fn delete_word_removes_row() {
        let db = Database::open_in_memory().unwrap();
        let id = db.insert_word(&sample_word("hello")).unwrap();
        assert!(db.is_word_saved("hello").unwrap());
        db.delete_word(id).unwrap();
        assert!(!db.is_word_saved("hello").unwrap());
        assert!(db.list_words(10, None).unwrap().is_empty());
    }

    #[test]
    fn is_word_saved_reflects_insert_state() {
        let db = Database::open_in_memory().unwrap();
        assert!(!db.is_word_saved("hello").unwrap());
        db.insert_word(&sample_word("hello")).unwrap();
        assert!(db.is_word_saved("hello").unwrap());
        // 重复收藏同一词：允许（返回 true 且插入成功，不强制唯一）。
        db.insert_word(&sample_word("hello")).unwrap();
        assert!(db.is_word_saved("hello").unwrap());
    }

    #[test]
    fn wordbook_ddl_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        // init 已跑过；再跑一次不应报错（幂等）
        db.init().unwrap();
        db.insert_word(&sample_word("x")).unwrap();
        db.list_words(10, None).unwrap();
    }
}
