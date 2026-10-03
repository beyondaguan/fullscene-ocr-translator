//! 翻译引擎共用的 HTTP 助手（基于 [`ureq`]，同步、启用 TLS 后可访问 https）。

use std::time::Duration;

/// 构建带整体超时的 ureq agent。
pub fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).build()
}

/// 最小 URL 编码（避免引入 percent-encoding 依赖）。
///
/// 仅编码非「非保留字符」(RFC 3986 unreserved) 的字节，足够覆盖翻译文本。
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 测试用最小 HTTP mock：对任意请求返回固定 JSON body。
#[cfg(test)]
pub(crate) mod test_util {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// 启动 mock 服务器，返回 (线程句柄, base_url)。drop 句柄关闭服务器。
    pub fn start_mock(body: &'static str) -> (thread::JoinHandle<()>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock 失败");
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut _req_line = String::new();
                let _ = reader.read_line(&mut _req_line);
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    let trimmed = line.trim_end();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(v) = trimmed.to_lowercase().strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut buf = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut buf);
                }
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (handle, format!("http://{}", addr))
    }
}
