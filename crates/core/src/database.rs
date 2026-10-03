//! 翻译历史库（SQLite）。
//!
//! 每次翻译落一条记录，供欢迎页「最近翻译」与工作界面溯源使用。
//! 数据库文件位置见 PRODUCTION.md §6：`%APPDATA%/FullSceneOCR/fullscene.db`。

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

    /// 建表（幂等）
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
}
