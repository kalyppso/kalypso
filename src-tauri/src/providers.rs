//! Model providers: which AI providers a namespace can use, and their models.
//!
//! The gateway routes `/<provider>/<path>` to `<PROVIDER>_BASE_URL/<path>` with
//! `<PROVIDER>_API_KEY` added, both gateway-scoped secrets the agents never see. This module
//! knows the common providers (their base URLs and whether they need a key), so connecting one
//! is "paste a key", and asks a provider which models it has. Anything that speaks the OpenAI
//! chat-completions API works as a custom provider with its own base URL.
//!
//! Claude models run on the Claude runtime (`claude-sdk`) through the `anthropic` route; every
//! other provider runs on the OpenAI-compatible runtime with models named `provider/model`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::store::Db;
use crate::vault::Vault;

pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub needs_key: bool,
    /// Where to get a key, for the link next to the field.
    pub keys_url: &'static str,
    /// Runs on this machine.
    pub local: bool,
    pub note: &'static str,
}

/// The providers KALYPSO knows. Others work as custom providers.
pub const PRESETS: &[Preset] = &[
    Preset {
        id: "anthropic",
        name: "Anthropic",
        base_url: "https://api.anthropic.com",
        needs_key: true,
        keys_url: "https://console.anthropic.com/settings/keys",
        local: false,
        note: "Claude models, on the Claude runtime with prompt caching.",
    },
    Preset {
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        needs_key: true,
        keys_url: "https://platform.openai.com/api-keys",
        local: false,
        note: "GPT models.",
    },
    Preset {
        id: "google",
        name: "Google Gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        needs_key: true,
        keys_url: "https://aistudio.google.com/apikey",
        local: false,
        note: "Gemini models, through Google's OpenAI-compatible endpoint.",
    },
    Preset {
        id: "mistral",
        name: "Mistral",
        base_url: "https://api.mistral.ai/v1",
        needs_key: true,
        keys_url: "https://console.mistral.ai/api-keys",
        local: false,
        note: "Mistral and Codestral models.",
    },
    Preset {
        id: "deepseek",
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        needs_key: true,
        keys_url: "https://platform.deepseek.com/api_keys",
        local: false,
        note: "DeepSeek chat and reasoning models.",
    },
    Preset {
        id: "xai",
        name: "xAI",
        base_url: "https://api.x.ai/v1",
        needs_key: true,
        keys_url: "https://console.x.ai",
        local: false,
        note: "Grok models.",
    },
    Preset {
        id: "groq",
        name: "Groq",
        base_url: "https://api.groq.com/openai/v1",
        needs_key: true,
        keys_url: "https://console.groq.com/keys",
        local: false,
        note: "Open models on fast hardware.",
    },
    Preset {
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        needs_key: true,
        keys_url: "https://openrouter.ai/keys",
        local: false,
        note: "Hundreds of models from many providers, with one key.",
    },
    Preset {
        id: "together",
        name: "Together AI",
        base_url: "https://api.together.xyz/v1",
        needs_key: true,
        keys_url: "https://api.together.ai/settings/api-keys",
        local: false,
        note: "Open models, hosted.",
    },
    Preset {
        id: "fireworks",
        name: "Fireworks AI",
        base_url: "https://api.fireworks.ai/inference/v1",
        needs_key: true,
        keys_url: "https://fireworks.ai/account/api-keys",
        local: false,
        note: "Open models, hosted.",
    },
    Preset {
        id: "cerebras",
        name: "Cerebras",
        base_url: "https://api.cerebras.ai/v1",
        needs_key: true,
        keys_url: "https://cloud.cerebras.ai",
        local: false,
        note: "Open models on fast hardware.",
    },
    Preset {
        id: "ollama",
        name: "Ollama",
        base_url: "http://localhost:11434/v1",
        needs_key: false,
        keys_url: "",
        local: true,
        note: "Models on this machine. Free per token.",
    },
    Preset {
        id: "lmstudio",
        name: "LM Studio",
        base_url: "http://localhost:1234/v1",
        needs_key: false,
        keys_url: "",
        local: true,
        note: "Models on this machine. Free per token.",
    },
    Preset {
        id: "vllm",
        name: "vLLM",
        base_url: "http://localhost:8000/v1",
        needs_key: false,
        keys_url: "",
        local: true,
        note: "Your own model server.",
    },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// `open-router` → `OPEN_ROUTER`, the prefix of its secrets.
pub fn secret_prefix(provider: &str) -> String {
    provider.to_ascii_uppercase().replace('-', "_")
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ModelProvider {
    /// The gateway route and the first half of `provider/model`.
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub needs_key: bool,
    pub keys_url: String,
    pub local: bool,
    pub note: String,
    /// Set up in this namespace: its key is saved, or (with no key needed) it was added.
    pub connected: bool,
    pub has_key: bool,
    /// Not one KALYPSO knows: added with its own base URL.
    pub custom: bool,
    /// "claude-sdk" for Anthropic, "openai-compat" for the rest.
    pub runtime: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct ProviderInput {
    pub id: String,
    /// Empty or absent: the provider's usual address (required for a custom provider).
    #[serde(default)]
    #[ts(optional)]
    pub base_url: Option<String>,
    /// Absent keeps the saved key.
    #[serde(default)]
    #[ts(optional)]
    pub api_key: Option<String>,
}

fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 40
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
        && !id.starts_with('_');
    if ok {
        Ok(())
    } else {
        Err(KalypsoError::Invalid("name the provider with lowercase letters, digits and dashes, for example my-llm".into()))
    }
}

fn check_base(url: &str) -> Result<()> {
    if (url.starts_with("https://") || url.starts_with("http://")) && url.len() <= 500 && !url.contains(char::is_whitespace) {
        Ok(())
    } else {
        Err(KalypsoError::Invalid("the base URL must start with http:// or https://".into()))
    }
}

/// Every known provider, plus custom ones this namespace added, with what is set up.
pub fn list(db: &Db, vault: &Vault, ns: &str) -> Result<Vec<ModelProvider>> {
    let secrets = vault.list(db, ns)?;
    let gateway = |key: &str| secrets.iter().any(|s| s.key == key && s.scope == "gateway");
    let mut out = Vec::new();
    for p in PRESETS {
        let prefix = secret_prefix(p.id);
        let has_key = gateway(&format!("{prefix}_API_KEY"));
        let has_base = gateway(&format!("{prefix}_BASE_URL"));
        let base_url =
            if has_base { vault.lookup(db, ns, &format!("{prefix}_BASE_URL"))?.unwrap_or_default() } else { p.base_url.to_string() };
        out.push(ModelProvider {
            id: p.id.into(),
            name: p.name.into(),
            base_url,
            needs_key: p.needs_key,
            keys_url: p.keys_url.into(),
            local: p.local,
            note: p.note.into(),
            connected: if p.needs_key { has_key } else { has_key || has_base },
            has_key,
            custom: false,
            runtime: if p.id == "anthropic" { "claude-sdk" } else { "openai-compat" }.into(),
        });
    }
    // Custom providers: a gateway-scoped <PREFIX>_BASE_URL that isn't a known provider's.
    for s in secrets.iter().filter(|s| s.scope == "gateway") {
        let Some(prefix) = s.key.strip_suffix("_BASE_URL") else { continue };
        let id = prefix.to_ascii_lowercase().replace('_', "-");
        if preset(&id).is_some() || check_id(&id).is_err() {
            continue;
        }
        let has_key = gateway(&format!("{prefix}_API_KEY"));
        out.push(ModelProvider {
            name: id.clone(),
            base_url: vault.lookup(db, ns, &s.key)?.unwrap_or_default(),
            needs_key: false,
            keys_url: String::new(),
            local: false,
            note: "Your own OpenAI-compatible provider.".into(),
            connected: true,
            has_key,
            custom: true,
            runtime: "openai-compat".into(),
            id,
        });
    }
    Ok(out)
}

/// Connect a provider, or change its address or key.
pub fn save(db: &Db, vault: &Vault, ns: &str, input: ProviderInput) -> Result<ModelProvider> {
    let id = input.id.trim().to_ascii_lowercase();
    check_id(&id)?;
    let known = preset(&id);
    let prefix = secret_prefix(&id);
    let base = input.base_url.map(|b| b.trim().trim_end_matches('/').to_string()).filter(|b| !b.is_empty());
    if let Some(b) = &base {
        check_base(b)?;
    }
    let key = input.api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let has_key = vault.lookup(db, ns, &format!("{prefix}_API_KEY"))?.is_some();
    match known {
        None if base.is_none() && vault.lookup(db, ns, &format!("{prefix}_BASE_URL"))?.is_none() => {
            return Err(KalypsoError::Invalid(format!("{id} isn't a provider KALYPSO knows; give its base URL")));
        }
        Some(p) if p.needs_key && key.is_none() && !has_key => {
            return Err(KalypsoError::Invalid(format!("paste your {} API key", p.name)));
        }
        _ => {}
    }
    match (&base, known) {
        // Its usual address: no secret needed, except to mark a keyless provider as added.
        (Some(b), Some(p)) if b == p.base_url.trim_end_matches('/') => {
            if !p.needs_key {
                vault.set(db, ns, &format!("{prefix}_BASE_URL"), b, "gateway")?;
            } else {
                remove_secret(db, vault, ns, &format!("{prefix}_BASE_URL"))?;
            }
        }
        (Some(b), _) => {
            vault.set(db, ns, &format!("{prefix}_BASE_URL"), b, "gateway")?;
        }
        (None, Some(p)) if !p.needs_key => {
            vault.set(db, ns, &format!("{prefix}_BASE_URL"), p.base_url, "gateway")?;
        }
        _ => {}
    }
    if let Some(k) = key {
        vault.set(db, ns, &format!("{prefix}_API_KEY"), &k, "gateway")?;
    }
    list(db, vault, ns)?.into_iter().find(|p| p.id == id).ok_or_else(|| KalypsoError::NotFound(format!("provider {id}")))
}

fn remove_secret(db: &Db, vault: &Vault, ns: &str, key: &str) -> Result<()> {
    if let Some(s) = vault.list(db, ns)?.into_iter().find(|s| s.key == key) {
        vault.delete(db, ns, &s.id)?;
    }
    Ok(())
}

/// Disconnect a provider: its key and address are removed from the vault.
pub fn remove(db: &Db, vault: &Vault, ns: &str, id: &str) -> Result<()> {
    check_id(id)?;
    let prefix = secret_prefix(id);
    remove_secret(db, vault, ns, &format!("{prefix}_API_KEY"))?;
    remove_secret(db, vault, ns, &format!("{prefix}_BASE_URL"))
}

/// The models a provider offers, from its own `/models` list. This is also the connection test:
/// a wrong key or address fails here with the provider's reason.
pub async fn models(db: &Db, vault: &Vault, http: &reqwest::Client, ns: &str, id: &str) -> Result<Vec<String>> {
    check_id(id)?;
    let prefix = secret_prefix(id);
    let base = match vault.lookup(db, ns, &format!("{prefix}_BASE_URL"))? {
        Some(b) => b,
        None => preset(id).map(|p| p.base_url.to_string()).ok_or_else(|| KalypsoError::Invalid(format!("{id} isn't connected")))?,
    };
    let key = vault.lookup(db, ns, &format!("{prefix}_API_KEY"))?;
    let base = base.trim_end_matches('/');
    let req = if id == "anthropic" {
        let mut r = http.get(format!("{base}/v1/models?limit=100")).header("anthropic-version", "2023-06-01");
        if let Some(k) = &key {
            r = r.header("x-api-key", k);
        }
        r
    } else {
        let mut r = http.get(format!("{base}/models"));
        if let Some(k) = &key {
            r = r.bearer_auth(k);
        }
        r
    };
    let res = req
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| KalypsoError::Invalid(format!("couldn't reach {id} at {base}: {}", e.without_url())))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        let reason = body["error"]["message"].as_str().or(body["error"].as_str()).or(body["message"].as_str()).unwrap_or("no reason given");
        return Err(KalypsoError::Invalid(format!("{id} answered {}: {reason}", status.as_u16())));
    }
    Ok(model_ids(&body))
}

/// `{"data": [{"id": …}]}` (OpenAI and Anthropic) or `{"models": [{"name": …}]}` (some servers).
fn model_ids(body: &serde_json::Value) -> Vec<String> {
    let items = body["data"].as_array().or(body["models"].as_array()).cloned().unwrap_or_default();
    let mut ids: Vec<String> = items
        .iter()
        .filter_map(|m| m["id"].as_str().or(m["name"].as_str()).map(|s| s.trim_start_matches("models/").to_string()))
        .filter(|s| !s.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> (Db, Vault) {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES ('work','work')", [])?)).unwrap();
        let vault = Vault::ephemeral();
        vault.create_ns_key(&db, "work").unwrap();
        (db, vault)
    }

    fn find(db: &Db, vault: &Vault, id: &str) -> ModelProvider {
        list(db, vault, "work").unwrap().into_iter().find(|p| p.id == id).unwrap()
    }

    #[test]
    fn known_providers_need_only_a_key() {
        let (db, vault) = env();
        assert!(!find(&db, &vault, "google").connected);
        let err = save(&db, &vault, "work", ProviderInput { id: "google".into(), base_url: None, api_key: None }).unwrap_err();
        assert!(err.to_string().contains("API key"), "{err}");

        let g =
            save(&db, &vault, "work", ProviderInput { id: "google".into(), base_url: None, api_key: Some(" AIza-test ".into()) }).unwrap();
        assert!(g.connected && g.has_key && !g.custom);
        assert_eq!(g.runtime, "openai-compat");
        assert_eq!(vault.lookup(&db, "work", "GOOGLE_API_KEY").unwrap().as_deref(), Some("AIza-test"));
        assert_eq!(vault.lookup(&db, "work", "GOOGLE_BASE_URL").unwrap(), None, "the usual address needs no secret");
        assert_eq!(find(&db, &vault, "anthropic").runtime, "claude-sdk");

        remove(&db, &vault, "work", "google").unwrap();
        assert!(!find(&db, &vault, "google").connected);
    }

    #[test]
    fn local_and_custom_providers() {
        let (db, vault) = env();
        // A local provider needs no key; adding it is enough.
        let o = save(&db, &vault, "work", ProviderInput { id: "ollama".into(), base_url: None, api_key: None }).unwrap();
        assert!(o.connected && o.local && !o.has_key);
        assert_eq!(o.base_url, "http://localhost:11434/v1");

        // Anything else that speaks the OpenAI API, with its own address.
        let err = save(&db, &vault, "work", ProviderInput { id: "my-llm".into(), base_url: None, api_key: None }).unwrap_err();
        assert!(err.to_string().contains("base URL"), "{err}");
        let c = save(
            &db,
            &vault,
            "work",
            ProviderInput { id: "my-llm".into(), base_url: Some("https://llm.example.com/v1/".into()), api_key: Some("k".into()) },
        )
        .unwrap();
        assert!(c.custom && c.connected && c.has_key);
        assert_eq!(c.base_url, "https://llm.example.com/v1");
        assert!(save(&db, &vault, "work", ProviderInput { id: "bad".into(), base_url: Some("ftp://x".into()), api_key: None }).is_err());
        assert!(
            save(&db, &vault, "work", ProviderInput { id: "Bad Name".into(), base_url: Some("https://x".into()), api_key: None }).is_err()
        );
    }

    #[test]
    fn model_lists_in_either_shape() {
        let openai = serde_json::json!({ "data": [{ "id": "gpt-5" }, { "id": "gpt-5-mini" }] });
        assert_eq!(model_ids(&openai), ["gpt-5", "gpt-5-mini"]);
        let other = serde_json::json!({ "models": [{ "name": "models/gemini-4-flash" }] });
        assert_eq!(model_ids(&other), ["gemini-4-flash"]);
    }
}
