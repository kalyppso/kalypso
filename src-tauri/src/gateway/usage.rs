//! Reading token usage out of provider responses, plain JSON or server-sent
//! events, without holding the whole stream in memory.

use serde_json::Value;

/// Tokens for one request. `input` excludes cached tokens on every provider.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Anthropic Messages API.
    Anthropic,
    /// OpenAI Chat Completions and Responses, and anything compatible with them.
    OpenAi,
}

/// Plain JSON bodies larger than this are passed through but not parsed.
const MAX_JSON: usize = 16 << 20;
/// Longest single SSE line we keep; usage events are far smaller.
const MAX_LINE: usize = 1 << 20;

/// Fed every response chunk; reports usage and model at the end.
pub struct Meter {
    format: Format,
    sse: bool,
    buf: Vec<u8>,
    overflow: bool,
    usage: Option<Usage>,
    model: Option<String>,
}

impl Meter {
    pub fn new(format: Format, sse: bool) -> Self {
        Self { format, sse, buf: Vec::new(), overflow: false, usage: None, model: None }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        if !self.sse {
            if self.buf.len() + chunk.len() > MAX_JSON {
                self.overflow = true;
                self.buf = Vec::new();
            }
            if !self.overflow {
                self.buf.extend_from_slice(chunk);
            }
            return;
        }
        for &b in chunk {
            if b == b'\n' {
                let line = std::mem::take(&mut self.buf);
                if !self.overflow {
                    self.line(&line);
                }
                self.overflow = false;
            } else if self.buf.len() < MAX_LINE {
                self.buf.push(b);
            } else {
                self.overflow = true;
            }
        }
    }

    /// Usage (if the response carried any) and the model the provider reported.
    pub fn finish(mut self) -> (Option<Usage>, Option<String>) {
        if self.sse {
            if !self.buf.is_empty() && !self.overflow {
                let line = std::mem::take(&mut self.buf);
                self.line(&line);
            }
        } else if !self.overflow {
            if let Ok(v) = serde_json::from_slice::<Value>(&self.buf) {
                self.event(&v);
            }
        }
        (self.usage, self.model)
    }

    fn line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Some(data) = line.strip_prefix(b"data:") else { return };
        if let Ok(v) = serde_json::from_slice::<Value>(data.trim_ascii()) {
            self.event(&v);
        }
    }

    fn event(&mut self, v: &Value) {
        match self.format {
            Format::Anthropic => {
                // Plain body is a message; streams nest it in `message_start` and
                // send running totals in `message_delta`.
                let msg = v.get("message").unwrap_or(v);
                if let Some(m) = msg.get("model").and_then(Value::as_str) {
                    self.model = Some(m.to_string());
                }
                let u = msg.get("usage").or_else(|| v.get("usage"));
                if let Some(u) = u.filter(|u| u.is_object()) {
                    self.usage = Some(anthropic(u, self.usage.unwrap_or_default()));
                }
            }
            Format::OpenAi => {
                // Responses API wraps the final object in `response.completed`.
                let obj = v.get("response").filter(|r| r.is_object()).unwrap_or(v);
                if let Some(m) = obj.get("model").and_then(Value::as_str) {
                    self.model = Some(m.to_string());
                }
                if let Some(u) = obj.get("usage").filter(|u| u.is_object()) {
                    self.usage = Some(openai(u));
                }
            }
        }
    }
}

fn n(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

/// Fields present in `u` replace those in `prev`: stream deltas carry running totals.
fn anthropic(u: &Value, prev: Usage) -> Usage {
    let mut out = prev;
    if let Some(x) = n(u, "input_tokens") {
        out.input = x;
    }
    if let Some(x) = n(u, "output_tokens") {
        out.output = x;
    }
    if let Some(x) = n(u, "cache_read_input_tokens") {
        out.cache_read = x;
    }
    let split = u.get("cache_creation").filter(|c| c.is_object());
    match (split, n(u, "cache_creation_input_tokens")) {
        (Some(c), total) => {
            let h1 = n(c, "ephemeral_1h_input_tokens").unwrap_or(0);
            let m5 = n(c, "ephemeral_5m_input_tokens").unwrap_or_else(|| total.unwrap_or(0).saturating_sub(h1));
            out.cache_write_1h = h1;
            out.cache_write_5m = m5;
        }
        (None, Some(total)) => {
            out.cache_write_5m = total;
            out.cache_write_1h = 0;
        }
        (None, None) => {}
    }
    out
}

fn openai(u: &Value) -> Usage {
    // Chat Completions: prompt/completion; Responses: input/output. Both count cached
    // tokens inside the prompt total.
    let prompt = n(u, "prompt_tokens").or_else(|| n(u, "input_tokens")).unwrap_or(0);
    let output = n(u, "completion_tokens").or_else(|| n(u, "output_tokens")).unwrap_or(0);
    let cached =
        ["prompt_tokens_details", "input_tokens_details"].iter().find_map(|k| u.get(*k).and_then(|d| n(d, "cached_tokens"))).unwrap_or(0);
    Usage { input: prompt.saturating_sub(cached), output, cache_read: cached.min(prompt), ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(format: Format, sse: bool, body: &str, chunk: usize) -> (Option<Usage>, Option<String>) {
        let mut m = Meter::new(format, sse);
        for c in body.as_bytes().chunks(chunk) {
            m.feed(c);
        }
        m.finish()
    }

    #[test]
    fn anthropic_json() {
        let body = r#"{"id":"msg_1","type":"message","model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}],
            "usage":{"input_tokens":12,"output_tokens":34,"cache_creation_input_tokens":100,"cache_read_input_tokens":200,
            "cache_creation":{"ephemeral_5m_input_tokens":60,"ephemeral_1h_input_tokens":40}}}"#;
        let (u, m) = run(Format::Anthropic, false, body, 7);
        assert_eq!(m.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(u, Some(Usage { input: 12, output: 34, cache_write_5m: 60, cache_write_1h: 40, cache_read: 200 }));
    }

    #[test]
    fn anthropic_stream_takes_running_totals() {
        let body = "event: message_start\r\n\
data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input_tokens\":25,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":1000,\"output_tokens\":1}}}\r\n\r\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"usage: lots\"}}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":15}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";
        for chunk in [1, 5, 64, 4096] {
            let (u, m) = run(Format::Anthropic, true, body, chunk);
            assert_eq!(m.as_deref(), Some("claude-sonnet-5-5"));
            assert_eq!(u, Some(Usage { input: 25, output: 15, cache_read: 1000, ..Default::default() }), "chunk {chunk}");
        }
    }

    #[test]
    fn openai_chat_json_and_stream() {
        let body = r#"{"model":"gpt-x","usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":64}}}"#;
        let want = Usage { input: 36, output: 20, cache_read: 64, ..Default::default() };
        assert_eq!(run(Format::OpenAi, false, body, 3).0, Some(want));

        let stream = "data: {\"model\":\"gpt-x\",\"choices\":[{\"delta\":{\"content\":\"a\"}}],\"usage\":null}\n\n\
data: {\"model\":\"gpt-x\",\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"prompt_tokens_details\":{\"cached_tokens\":64}}}\n\n\
data: [DONE]\n\n";
        assert_eq!(run(Format::OpenAi, true, stream, 9), (Some(want), Some("gpt-x".into())));
    }

    #[test]
    fn openai_responses_stream() {
        let stream = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"model\":\"gpt-y\",\"usage\":null}}\n\n\
event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-y\",\"usage\":{\"input_tokens\":50,\"output_tokens\":5,\"input_tokens_details\":{\"cached_tokens\":10}}}}\n\n";
        let (u, m) = run(Format::OpenAi, true, stream, 11);
        assert_eq!(m.as_deref(), Some("gpt-y"));
        assert_eq!(u, Some(Usage { input: 40, output: 5, cache_read: 10, ..Default::default() }));
    }

    #[test]
    fn no_usage_and_garbage_are_harmless() {
        assert_eq!(run(Format::Anthropic, false, "{\"type\":\"error\"}", 4), (None, None));
        assert_eq!(run(Format::OpenAi, true, "data: {not json\n\n: comment\n", 2), (None, None));
        assert_eq!(run(Format::OpenAi, false, "<html>", 2), (None, None));
    }
}
