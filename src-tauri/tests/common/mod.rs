//! A stand-in for the Anthropic Messages API that scripts an agent's turns, shared by
//! the end-to-end tests. Nothing here reaches a real model.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use axum::response::IntoResponse;
use kalypso_lib::vault::new_id;
use serde_json::{json, Value};

pub const TASK: &str = "KX-TASK: write a marker file, then try to force-push.";

/// What the stand-in model says next, from how far the conversation has got.
fn reply(body: &Value) -> Value {
    let msgs = body["messages"].as_array().cloned().unwrap_or_default();
    let ours = msgs.iter().any(|m| m.to_string().contains("KX-TASK"));
    let results = msgs
        .iter()
        .filter(|m| m["role"] == "user")
        .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
        .filter(|b| b["type"] == "tool_result")
        .count();
    let tool = |id: &str, command: &str| json!({ "type": "tool_use", "id": id, "name": "Bash", "input": { "command": command, "description": "test step" } });
    let (content, stop) = match (ours, results) {
        // Side calls (titles, summaries): a short answer.
        (false, _) => (vec![json!({ "type": "text", "text": "ok" })], "end_turn"),
        (true, 0) => (vec![tool("toolu_01", "echo kalypso-sdk > /work/done.txt")], "tool_use"),
        (true, 1) => (vec![tool("toolu_02", "git push --force origin main")], "tool_use"),
        (true, _) => (vec![json!({ "type": "text", "text": "Marker written; the force-push was blocked by policy." })], "end_turn"),
    };
    json!({
        "id": format!("msg_{}", new_id("m")), "type": "message", "role": "assistant",
        "model": body["model"], "content": content, "stop_reason": stop, "stop_sequence": null,
        "usage": { "input_tokens": 100, "output_tokens": 20 }
    })
}

/// The same message as the Messages API's server-sent events.
fn sse(msg: &Value) -> String {
    let mut out = String::new();
    let mut ev = |name: &str, data: Value| out.push_str(&format!("event: {name}\ndata: {data}\n\n"));
    let mut start = msg.clone();
    start["content"] = json!([]);
    start["stop_reason"] = Value::Null;
    start["usage"] = json!({ "input_tokens": 100, "output_tokens": 1 });
    ev("message_start", json!({ "type": "message_start", "message": start }));
    for (i, b) in msg["content"].as_array().unwrap().iter().enumerate() {
        if b["type"] == "text" {
            ev(
                "content_block_start",
                json!({ "type": "content_block_start", "index": i, "content_block": { "type": "text", "text": "" } }),
            );
            ev(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": i, "delta": { "type": "text_delta", "text": b["text"] } }),
            );
        } else {
            let mut head = b.clone();
            head["input"] = json!({});
            ev("content_block_start", json!({ "type": "content_block_start", "index": i, "content_block": head }));
            ev(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": i, "delta": { "type": "input_json_delta", "partial_json": b["input"].to_string() } }),
            );
        }
        ev("content_block_stop", json!({ "type": "content_block_stop", "index": i }));
    }
    ev(
        "message_delta",
        json!({ "type": "message_delta", "delta": { "stop_reason": msg["stop_reason"], "stop_sequence": null }, "usage": { "output_tokens": 20 } }),
    );
    ev("message_stop", json!({ "type": "message_stop" }));
    out
}

pub async fn model(seen: Arc<Mutex<Vec<String>>>) -> String {
    let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", up.local_addr().unwrap());
    let app = axum::Router::new().fallback(move |uri: axum::http::Uri, h: axum::http::HeaderMap, body: axum::body::Bytes| {
        let seen = seen.clone();
        async move {
            let key = h.get("x-api-key").and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
            seen.lock().unwrap().push(format!("{} key={key}", uri.path()));
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if uri.path().ends_with("/count_tokens") {
                return axum::Json(json!({ "input_tokens": 100 })).into_response();
            }
            if !uri.path().ends_with("/v1/messages") {
                return axum::Json(json!({})).into_response();
            }
            let msg = reply(&body);
            if body["stream"] == true {
                ([("content-type", "text/event-stream")], sse(&msg)).into_response()
            } else {
                axum::Json(msg).into_response()
            }
        }
    });
    tokio::spawn(async move { axum::serve(up, app).await.unwrap() });
    url
}
